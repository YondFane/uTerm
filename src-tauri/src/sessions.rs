use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex, OnceLock,
};
use std::time::Duration;
use tauri::{ipc::Channel, Manager};
use utermd_local::daemon::{
    Client, Frame, HostStatus, Operation, Reply, SessionSnapshot, SessionSpec,
};

pub struct Link {
    session: String,
    generation: String,
    client: Client,
    stopped: AtomicBool,
    pending: Mutex<Option<u64>>,
    acknowledged: Condvar,
}
impl Link {
    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.acknowledged.notify_all();
    }
}
#[derive(Default)]
pub struct Sessions {
    executable: OnceLock<std::path::PathBuf>,
    lifecycle: Mutex<()>,
    links: Mutex<HashMap<String, Arc<Link>>>,
}

fn local_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("local-daemon-v1"))
        .map_err(|error| error.to_string())
}

fn local_client(app: &tauri::AppHandle, state: &Sessions) -> Result<Client, String> {
    let _guard = state.lifecycle.lock().map_err(|error| error.to_string())?;
    let root = local_root(app)?;
    let executable = state.host_executable(&root)?;
    if let Ok(client) = Client::connect(&root) {
        let Reply::HostStatus(HostStatus {
            executable: running_executable,
            sessions,
            ..
        }) = client
            .request(Operation::HostStatus)
            .map_err(|error| error.to_string())?
        else {
            return Err("后台会话响应无效。".into());
        };
        if running_executable == executable || sessions.iter().any(|session| session.running) {
            return Ok(client);
        }
        match client.request(Operation::ShutdownIfIdle) {
            Ok(Reply::Done) => {}
            Err(error) => {
                eprintln!("Idle host upgrade deferred: {error}");
                return Ok(client);
            }
            _ => return Err("后台未确认安全退出。".into()),
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while root.join("endpoint.json").exists() {
            if std::time::Instant::now() >= deadline {
                return Err("后台尚未退出，请稍后重试。".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    utermd_local::daemon::ensure_running(&root, &executable).map_err(|error| format!("{error:#}"))
}

impl Sessions {
    // Call under lifecycle: status polling and startup must stage one executable.
    // 在生命周期锁内调用，避免状态轮询与启动重复暂存同一程序。
    fn host_executable(&self, root: &std::path::Path) -> Result<std::path::PathBuf, String> {
        if let Some(path) = self.executable.get() {
            return Ok(path.clone());
        }
        let source = std::env::current_exe().map_err(|error| error.to_string())?;
        let path = stage_host(root, &source)?;
        self.executable
            .set(path.clone())
            .map_err(|_| "后台程序已被并发初始化。")?;
        Ok(path)
    }

    fn remove_link(&self, attachment: &str, expected: &Arc<Link>) -> Result<(), String> {
        let mut links = self.links.lock().map_err(|error| error.to_string())?;
        // A late close or reader exit must not remove a newly reconnected link.
        // 迟到的关闭响应或读取线程退出不能移除刚重新连接的新链路。
        if links
            .get(attachment)
            .is_some_and(|current| Arc::ptr_eq(current, expected))
        {
            links.remove(attachment);
        }
        Ok(())
    }

    pub fn detach(&self) {
        match self.links.lock() {
            Ok(mut links) => {
                for link in links.drain().map(|(_, link)| link) {
                    link.stop();
                }
            }
            Err(error) => eprintln!("Could not detach session links: {error}"),
        }
    }
    fn get(&self, attachment: &str) -> Result<Arc<Link>, String> {
        self.links
            .lock()
            .map_err(|error| error.to_string())?
            .get(attachment)
            .cloned()
            .ok_or_else(|| "Session is disconnected".into())
    }
}

#[derive(Deserialize)]
pub struct StartRequest {
    id: String,
    attachment: String,
    directory: String,
    shell: String,
    agent: Option<String>,
    rows: u16,
    cols: u16,
}

#[tauri::command]
pub async fn local_session_list(app: tauri::AppHandle) -> Result<SessionSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = local_root(&app)?;
        // Discovery must not start an otherwise unused host or replace a live one.
        // 会话发现不得启动未使用的宿主，也不得替换正在运行的宿主。
        if !root.join("endpoint.json").exists() {
            return Ok(SessionSnapshot::default());
        }
        let client = Client::connect(&root).map_err(|error| error.to_string())?;
        match client
            .request(Operation::SessionSnapshot)
            .map_err(|error| error.to_string())?
        {
            Reply::SessionSnapshot(snapshot) => Ok(snapshot),
            _ => Err("Invalid local session list".into()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn start_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Sessions>>,
    request: StartRequest,
    events: Channel<Frame>,
) -> Result<(), String> {
    let StartRequest {
        id,
        attachment,
        directory,
        shell,
        agent,
        rows,
        cols,
    } = request;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let client = local_client(&app, &state)?;
        if agent.is_some() {
            client
                .require_agent_support()
                .map_err(|error| error.to_string())?;
        }
        let generation = match client
            .request(Operation::Open {
                spec: SessionSpec {
                    id: id.clone(),
                    directory: directory.into(),
                    shell,
                    agent,
                },
                rows,
                cols,
            })
            .map_err(|error| format!("{error:#}"))?
        {
            Reply::Opened { generation } => generation,
            _ => return Err("Invalid session response".into()),
        };
        let link = Arc::new(Link {
            session: id,
            generation,
            client,
            stopped: AtomicBool::new(false),
            pending: Mutex::new(None),
            acknowledged: Condvar::new(),
        });
        if let Some(old) = state
            .links
            .lock()
            .map_err(|error| error.to_string())?
            .insert(attachment.clone(), link.clone())
        {
            old.stop();
        }
        std::thread::spawn(move || {
            let result = stream(&link, &events);
            if let Err(error) = result {
                if !link.stopped.load(Ordering::Acquire) {
                    let frame = Frame {
                        agent_state: None,
                        foreground_agent: None,
                        sequence: 0,
                        reset: false,
                        rows,
                        cols,
                        data: vec![],
                        exited: false,
                        code: None,
                        error: Some(format!("连接已断开：{error}。请重新连接。")),
                    };
                    if let Err(error) = events.send(frame) {
                        eprintln!("Could not report disconnected session: {error}");
                    }
                }
            }
            link.stop();
            if let Err(error) = state.remove_link(&attachment, &link) {
                eprintln!("Could not remove disconnected link: {error}");
            }
        });
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn stream(link: &Link, events: &Channel<Frame>) -> Result<(), String> {
    let mut cursor = None;
    while !link.stopped.load(Ordering::Acquire) {
        let frame = match link
            .client
            .request(Operation::Read {
                id: link.session.clone(),
                generation: link.generation.clone(),
                after: cursor,
            })
            .map_err(|error| format!("{error:#}"))?
        {
            Reply::Frame(frame) => frame,
            _ => return Err("Invalid output response".into()),
        };
        if link.stopped.load(Ordering::Acquire) {
            break;
        }
        if cursor == Some(frame.sequence) && !frame.reset {
            continue;
        }
        cursor = Some(frame.sequence);
        let exited = frame.exited;
        *link.pending.lock().map_err(|error| error.to_string())? = Some(frame.sequence);
        // Wait for the renderer's acknowledgement before requesting more output.
        // 等待渲染端确认后再请求下一帧，避免输出积压并保持回放顺序。
        events.send(frame).map_err(|error| error.to_string())?;
        let mut pending = link.pending.lock().map_err(|error| error.to_string())?;
        while pending.is_some() && !link.stopped.load(Ordering::Acquire) {
            pending = link
                .acknowledged
                .wait_timeout(pending, Duration::from_millis(250))
                .map_err(|error| error.to_string())?
                .0;
        }
        // Retain the attachment so Close and Restart work after a natural exit.
        // 自然退出后保留链路，确保关闭和重启操作仍可使用。
        if exited {
            while !link.stopped.load(Ordering::Acquire) {
                pending = link
                    .acknowledged
                    .wait_timeout(pending, Duration::from_secs(1))
                    .map_err(|error| error.to_string())?
                    .0;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn session_action(
    state: tauri::State<'_, Arc<Sessions>>,
    id: String,
    action: String,
    data: Option<Vec<u8>>,
    rows: Option<u16>,
    cols: Option<u16>,
    sequence: Option<u64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if action == "detach" {
            if let Some(link) = state
                .links
                .lock()
                .map_err(|error| error.to_string())?
                .remove(&id)
            {
                link.stop();
            }
            return Ok(());
        }
        let link = state.get(&id)?;
        if action == "ack" {
            let mut pending = link.pending.lock().map_err(|error| error.to_string())?;
            if *pending == sequence {
                *pending = None;
                link.acknowledged.notify_all();
            }
            return Ok(());
        }
        let session = link.session.clone();
        let generation = link.generation.clone();
        let operation = match action.as_str() {
            "write" => Operation::Write {
                id: session,
                generation,
                data: data.ok_or("Missing input")?,
            },
            "resize" => Operation::Resize {
                id: session,
                generation,
                rows: rows.ok_or("Missing rows")?,
                cols: cols.ok_or("Missing columns")?,
            },
            "close" => Operation::Close {
                id: session,
                generation,
            },
            _ => return Err("Unknown session action".into()),
        };
        link.client
            .request(operation)
            .map_err(|error| format!("{error:#}"))?;
        if action == "close" {
            link.stop();
            state.remove_link(&id, &link)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_directory(directory: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&directory);
        if !path.is_absolute() || !path.is_dir() {
            return Err("请输入已存在目录的绝对路径。".into());
        }
        path.canonicalize()
            .map_err(|error| error.to_string())?
            .into_os_string()
            .into_string()
            .map_err(|_| "目录名称无法转换为文本。".into())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn control_session(
    state: tauri::State<'_, Arc<Sessions>>,
    id: String,
    action: String,
    text: Option<String>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let link = state
            .links
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .find(|link| link.session == id && !link.stopped.load(Ordering::Acquire))
            .cloned()
            .ok_or("会话尚未连接，请稍后重试。")?;
        let operation = match action.as_str() {
            "send" => {
                let data = text.ok_or("缺少输入文本。")?.into_bytes();
                if data.len() > 65536 {
                    return Err("输入超过 64 KB。".into());
                }
                Operation::Write {
                    id,
                    generation: link.generation.clone(),
                    data,
                }
            }
            "close" => Operation::Close {
                id,
                generation: link.generation.clone(),
            },
            "acknowledge" => Operation::Report {
                id,
                generation: link.generation.clone(),
                state: "idle".into(),
            },
            _ => return Err("未知会话操作。".into()),
        };
        link.client.request(operation).map_err(|e| e.to_string())?;
        if action == "close" {
            link.stop();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Installers may replace or terminate the app executable. Keep the host and its
// agent reporter outside the installation directory, under a content identity.
// 安装器可能替换或结束应用程序；将宿主及 Agent 报告程序按内容哈希存放在安装目录外。
fn stage_host(
    root: &std::path::Path,
    source: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    let mut input = std::fs::File::open(source).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let mut temporary = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        temporary
            .write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
    }
    let digest = format!("{:x}", hash.finalize());
    let directory = root.join("executables").join(digest);
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let destination = directory.join(if cfg!(windows) {
        "uterm-session-host.exe"
    } else {
        "uterm-session-host"
    });
    if destination.exists() {
        let mut existing = std::fs::File::open(&destination).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        loop {
            let count = existing.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if directory.file_name().and_then(|value| value.to_str())
            != Some(format!("{:x}", hash.finalize()).as_str())
        {
            return Err("后台程序副本校验失败，请退出应用后移除该副本再重试。".into());
        }
        return Ok(destination);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    match temporary.persist_noclobber(&destination) {
        Ok(_) => Ok(destination),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            stage_host(root, source)
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod update_tests {
    use super::*;
    #[test]
    fn stale_close_does_not_remove_a_reconnected_attachment() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        std::fs::write(directory.path().join("endpoint.json"), serde_json::to_vec(
            &serde_json::json!({"version": 1, "port": listener.local_addr().unwrap().port(), "token": "test"})
        ).unwrap()).unwrap();
        // Only simulate the initial handshake; this regression must not launch a real host.
        // 只模拟初始握手，此回归测试不得启动真实宿主。
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut length = [0; 4];
            socket.read_exact(&mut length).unwrap();
            let mut request = vec![0; u32::from_be_bytes(length) as usize];
            socket.read_exact(&mut request).unwrap();
            let reply = serde_json::to_vec(&Reply::Ready {
                pid: 1,
                capabilities: vec![],
            })
            .unwrap();
            socket
                .write_all(&(reply.len() as u32).to_be_bytes())
                .unwrap();
            socket.write_all(&reply).unwrap();
        });
        let client = Client::connect(directory.path()).unwrap();
        server.join().unwrap();
        let make_link = || {
            Arc::new(Link {
                session: "session".into(),
                generation: "generation".into(),
                client: client.clone(),
                stopped: AtomicBool::new(false),
                pending: Mutex::new(None),
                acknowledged: Condvar::new(),
            })
        };
        let old = make_link();
        let current = make_link();
        let state = Sessions::default();
        state
            .links
            .lock()
            .unwrap()
            .insert("attachment".into(), current.clone());
        state.remove_link("attachment", &old).unwrap();
        assert!(Arc::ptr_eq(&state.get("attachment").unwrap(), &current));
        state.remove_link("attachment", &current).unwrap();
        assert!(state.get("attachment").is_err());
    }

    #[test]
    fn host_copies_survive_app_replacement_and_detect_corruption() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("app");
        let root = directory.path().join("state");
        std::fs::write(&source, b"old executable").unwrap();
        let old = stage_host(&root, &source).unwrap();
        assert_eq!(stage_host(&root, &source).unwrap(), old);
        std::fs::write(&source, b"new executable").unwrap();
        let new = stage_host(&root, &source).unwrap();
        assert_ne!(new, old);
        assert_eq!(std::fs::read(&old).unwrap(), b"old executable");
        std::fs::write(&new, b"corrupt").unwrap();
        assert!(stage_host(&root, &source).is_err());
    }
}
