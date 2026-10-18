use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    net::TcpListener,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use utermd_local::{
    ssh::{validate_host, SshTarget},
    BackgroundChild,
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Forward {
    id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
}
impl Forward {
    fn validate(&self) -> Result<()> {
        validate_host(&self.remote_host)?;
        if uuid::Uuid::parse_str(&self.id).is_err()
            || self.local_port == 0
            || self.remote_port == 0
            || self.remote_host.contains(['@', '[', ']'])
            || (self.remote_host.contains(':')
                && self.remote_host.parse::<std::net::Ipv6Addr>().is_err())
        {
            bail!("SSH_INVALID_FORWARD");
        }
        Ok(())
    }
    fn specification(&self) -> String {
        let host = if self.remote_host.contains(':') {
            format!("[{}]", self.remote_host)
        } else {
            self.remote_host.clone()
        };
        format!("127.0.0.1:{}:{host}:{}", self.local_port, self.remote_port)
    }
    fn reserve(&self) -> Result<TcpListener> {
        TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, self.local_port)).map_err(|error| {
            anyhow::anyhow!(if error.kind() == std::io::ErrorKind::AddrInUse {
                "SSH_FORWARD_PORT_BUSY"
            } else {
                "SSH_FORWARD_BIND_FAILED"
            })
        })
    }
}
#[derive(Clone, Serialize)]
pub struct Status {
    id: String,
    connection_id: String,
    state: String,
    error: Option<String>,
}
struct Entry {
    token: uuid::Uuid,
    status: Status,
    child: Arc<Mutex<Option<BackgroundChild>>>,
    cancelled: Arc<AtomicBool>,
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut child) = self.child.lock() {
            child.take();
        }
    }
}
#[derive(Default)]
pub struct SshTunnels {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
}
impl SshTunnels {
    pub fn stop(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
    }
}
fn key(connection: &str, id: &str) -> String {
    format!("{connection}/{id}")
}
fn spawn_ready(
    command: &mut std::process::Command,
    port: u16,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
    process: Arc<Mutex<Option<BackgroundChild>>>,
) -> Result<()> {
    let mut slot = process
        .lock()
        .map_err(|_| anyhow::anyhow!("SSH_FORWARD_FAILED"))?;
    if cancelled.load(Ordering::Acquire) {
        bail!("SSH_FORWARD_CANCELLED");
    }
    let mut child = BackgroundChild::spawn(command)?;
    let mut stderr = child.take_stderr().context("SSH_PIPE_FAILED")?;
    *slot = Some(child);
    drop(slot);
    let diagnostics = Arc::new(Mutex::new(Vec::<u8>::new()));
    let output = diagnostics.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 2048];
        while let Ok(count) = stderr.read(&mut buffer) {
            if count == 0 {
                break;
            }
            if let Ok(mut output) = output.lock() {
                output.extend_from_slice(&buffer[..count]);
                if output.len() > 65536 {
                    let excess = output.len() - 65536;
                    output.drain(..excess);
                }
            }
        }
    });
    let started = Instant::now();
    let marker = format!("Local forwarding listening on 127.0.0.1 port {port}.");
    loop {
        if cancelled.load(Ordering::Acquire) {
            bail!("SSH_FORWARD_CANCELLED");
        }
        if process
            .lock()
            .map_err(|_| anyhow::anyhow!("SSH_FORWARD_FAILED"))?
            .as_mut()
            .context("SSH_FORWARD_CANCELLED")?
            .try_wait()?
            .is_some()
        {
            bail!("SSH_FORWARD_FAILED");
        }
        // Confirm OpenSSH's own listener without sending a probe to the remote service.
        // 确认 OpenSSH 自身的监听日志，避免向远端服务发送探测请求。
        if diagnostics
            .lock()
            .map_err(|_| anyhow::anyhow!("SSH_FORWARD_FAILED"))?
            .windows(marker.len())
            .any(|value| value == marker.as_bytes())
        {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            bail!("SSH_TIMEOUT");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[tauri::command]
pub async fn ssh_tunnel_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshTunnels>,
    connection: SshTarget,
    rule: Forward,
) -> Result<Status, String> {
    connection.validate().map_err(|error| error.to_string())?;
    rule.validate()
        .map_err(|_| "SSH_INVALID_FORWARD".to_string())?;
    let key = key(&connection.connection_id, &rule.id);
    let token = uuid::Uuid::new_v4();
    let cancelled = Arc::new(AtomicBool::new(false));
    let process = Arc::new(Mutex::new(None));
    let status = Status {
        id: rule.id.clone(),
        connection_id: connection.connection_id.clone(),
        state: "starting".into(),
        error: None,
    };
    let entries = state.entries.clone();
    {
        let mut entries = entries.lock().map_err(|_| "SSH_FORWARD_FAILED")?;
        if entries
            .get(&key)
            .is_some_and(|entry| entry.status.state != "error")
        {
            return Err("SSH_FORWARD_BUSY".into());
        }
        if entries
            .values()
            .filter(|entry| entry.status.state != "error")
            .count()
            >= 16
            || entries.len() >= 128
        {
            return Err("SSH_FORWARD_LIMIT".into());
        }
        entries.insert(
            key.clone(),
            Entry {
                token,
                status: status.clone(),
                child: process.clone(),
                cancelled: cancelled.clone(),
            },
        );
    }
    tauri::async_runtime::spawn(async move {
        let result: Result<()> = async {
            let prepared = crate::ssh_auth::prepare(&app, &connection).await?;
            if cancelled.load(Ordering::Acquire) {
                bail!("SSH_FORWARD_CANCELLED");
            }
            if prepared.effective.forwarding {
                bail!("SSH_FORWARD_CONFIG_CONFLICT");
            }
            let mut command = crate::ssh::base_command()?;
            command.args(connection.options());
            prepared.apply(&mut command)?;
            command.args(prepared.resolved()?.options()?);
            command.args([
                "-o",
                if prepared.askpass.is_some() {
                    "BatchMode=no"
                } else {
                    "BatchMode=yes"
                },
                "-o",
                if prepared.askpass.is_some() {
                    "StrictHostKeyChecking=ask"
                } else {
                    "StrictHostKeyChecking=yes"
                },
            ]);
            let host = connection.host;
            tauri::async_runtime::spawn_blocking(move || {
                // Keep the destination last, after all locally constructed options.
                // 目标主机始终放在所有本机构造的选项之后。
                let mut wrapped = command;
                let reservation = rule.reserve()?;
                wrapped.args([
                    "-v",
                    "-N",
                    "-T",
                    "-S",
                    "none",
                    "-o",
                    "ControlMaster=no",
                    "-o",
                    "ExitOnForwardFailure=yes",
                    "-o",
                    "ClearAllForwardings=no",
                    "-o",
                    "GatewayPorts=no",
                    "-o",
                    "PermitLocalCommand=no",
                    "-o",
                    "ForwardAgent=no",
                    "-o",
                    "ForwardX11=no",
                    "-o",
                    "RemoteCommand=none",
                    "-o",
                    "LogLevel=DEBUG1",
                    "-o",
                    "ConnectTimeout=12",
                    "-o",
                    "ServerAliveInterval=30",
                    "-o",
                    "ServerAliveCountMax=3",
                    "-L",
                    &rule.specification(),
                    "--",
                    &host,
                ]);
                wrapped.stdin(Stdio::null()).stdout(Stdio::null());
                drop(reservation);
                spawn_ready(
                    &mut wrapped,
                    rule.local_port,
                    Duration::from_secs(60),
                    cancelled,
                    process,
                )
            })
            .await?
        }
        .await;
        if let Ok(mut entries) = entries.lock() {
            if let Some(entry) = entries.get_mut(&key).filter(|entry| entry.token == token) {
                match result {
                    Ok(()) => {
                        entry.status.state = "running".into();
                    }
                    Err(error) => {
                        if let Ok(mut child) = entry.child.lock() {
                            child.take();
                        }
                        entry.status.state = "error".into();
                        entry.status.error = Some(error.to_string());
                    }
                }
            }
        }
    });
    Ok(status)
}
#[tauri::command]
pub async fn ssh_tunnel_list(state: tauri::State<'_, SshTunnels>) -> Result<Vec<Status>, String> {
    let entries = state.entries.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = entries
            .lock()
            .map_err(|_| "SSH_FORWARD_FAILED".to_string())?;
        for entry in entries.values_mut() {
            if entry.status.state == "running"
                && entry.child.lock().map_or(true, |mut child| {
                    child
                        .as_mut()
                        .is_none_or(|child| !matches!(child.try_wait(), Ok(None)))
                })
            {
                if let Ok(mut child) = entry.child.lock() {
                    child.take();
                }
                entry.status.state = "error".into();
                entry.status.error = Some("SSH_FORWARD_ENDED".into());
            }
        }
        Ok(entries.values().map(|entry| entry.status.clone()).collect())
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn ssh_tunnel_stop(
    state: tauri::State<'_, SshTunnels>,
    connection_id: String,
    id: String,
) -> Result<(), String> {
    let entries = state.entries.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let entry = entries
            .lock()
            .map_err(|_| "SSH_FORWARD_FAILED".to_string())?
            .remove(&key(&connection_id, &id));
        drop(entry);
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn child_fixture() {
        if let Ok(mode) = std::env::var("UTERM_SSH_FORWARD_FIXTURE") {
            if mode == "exit" {
                return;
            }
            if mode == "ready" {
                eprintln!("debug1: Local forwarding listening on 127.0.0.1 port 43210.");
            }
            std::thread::sleep(Duration::from_secs(20));
        }
    }
    fn fixture(mode: &str) -> std::process::Command {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "ssh_tunnels::tests::child_fixture",
                "--nocapture",
            ])
            .env("UTERM_SSH_FORWARD_FIXTURE", mode)
            .stderr(Stdio::piped());
        command
    }
    #[test]
    fn readiness_waits_for_our_listener_and_entry_drop_stops_the_process() {
        let child = Arc::new(Mutex::new(None));
        let cancelled = Arc::new(AtomicBool::new(false));
        spawn_ready(
            &mut fixture("ready"),
            43210,
            Duration::from_secs(5),
            cancelled.clone(),
            child.clone(),
        )
        .unwrap();
        assert!(child
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none());
        let entry = Entry {
            token: uuid::Uuid::new_v4(),
            status: Status {
                id: "id".into(),
                connection_id: "connection".into(),
                state: "running".into(),
                error: None,
            },
            child: child.clone(),
            cancelled: cancelled.clone(),
        };
        drop(entry);
        assert!(cancelled.load(Ordering::Acquire));
        assert!(child.lock().unwrap().is_none());
    }
    #[test]
    fn startup_exit_timeout_and_cancel_are_visible_failures() {
        for (mode, cancelled, expected) in [
            ("exit", false, "SSH_FORWARD_FAILED"),
            ("hang", false, "SSH_TIMEOUT"),
            ("ready", true, "SSH_FORWARD_CANCELLED"),
        ] {
            let child = Arc::new(Mutex::new(None));
            let result = spawn_ready(
                &mut fixture(mode),
                43210,
                Duration::from_millis(200),
                Arc::new(AtomicBool::new(cancelled)),
                child.clone(),
            );
            assert_eq!(result.unwrap_err().to_string(), expected);
            child.lock().unwrap().take();
        }
        let child = Arc::new(Mutex::new(None));
        let cancelled = Arc::new(AtomicBool::new(false));
        let entry = Entry {
            token: uuid::Uuid::new_v4(),
            status: Status {
                id: "pending".into(),
                connection_id: "connection".into(),
                state: "starting".into(),
                error: None,
            },
            child: child.clone(),
            cancelled: cancelled.clone(),
        };
        let process = child.clone();
        let worker = std::thread::spawn(move || {
            spawn_ready(
                &mut fixture("hang"),
                43210,
                Duration::from_secs(5),
                cancelled,
                process,
            )
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while child.lock().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(child.lock().unwrap().is_some());
        drop(entry);
        assert_eq!(
            worker.join().unwrap().unwrap_err().to_string(),
            "SSH_FORWARD_CANCELLED"
        );
        assert!(child.lock().unwrap().is_none());
    }
    #[test]
    fn forwards_are_loopback_only_and_reject_options_and_invalid_ports() {
        let mut rule = Forward {
            id: uuid::Uuid::new_v4().to_string(),
            local_port: 8080,
            remote_host: "::1".into(),
            remote_port: 80,
        };
        rule.validate().unwrap();
        assert_eq!(rule.specification(), "127.0.0.1:8080:[::1]:80");
        for host in [
            "-oProxyCommand=bad",
            "host;exec",
            "user@host",
            "[::1]",
            "host:80",
        ] {
            rule.remote_host = host.into();
            assert!(rule.validate().is_err());
        }
        rule.remote_host = "localhost".into();
        let occupied = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        rule.local_port = occupied.local_addr().unwrap().port();
        assert_eq!(
            rule.reserve().unwrap_err().to_string(),
            "SSH_FORWARD_PORT_BUSY"
        );
        rule.local_port = 0;
        assert!(rule.validate().is_err());
    }
}
