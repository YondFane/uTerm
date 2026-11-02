use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs::{File, OpenOptions},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

#[cfg(test)]
use std::io::Write;
pub use utermd_local::control::{cli, valid_link};
#[cfg(test)]
use utermd_local::control::{parse_arguments, LIMIT};
use utermd_local::control::{read_message, write_message, Endpoint};
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}
struct Pending {
    request: Request,
    expires: Instant,
    reply: mpsc::SyncSender<Value>,
    claimed: bool,
}
pub struct Control {
    root: PathBuf,
    endpoint: Endpoint,
    enabled: AtomicBool,
    queue: Mutex<VecDeque<Pending>>,
    ready: tokio::sync::Notify,
    clients: AtomicUsize,
    _ownership: File,
}
fn private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| error.to_string())
}
fn write_private(path: &Path, value: &Value) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid path")?)
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, value).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
impl Control {
    pub fn start(app: &tauri::AppHandle) -> Result<Arc<Self>, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("control-v1");
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let ownership = private_file(&root.join("owner.lock"))?;
        ownership
            .try_lock()
            .map_err(|_| "本地控制服务已被另一个实例占用。")?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let endpoint = Endpoint {
            version: 1,
            port: listener.local_addr().map_err(|e| e.to_string())?.port(),
            token: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
        };
        let enabled = match std::fs::read(root.join("settings.json")) {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?
                ["enabled"]
                .as_bool()
                .ok_or("本地控制设置无效。")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(e.to_string()),
        };
        let service = Arc::new(Self {
            root,
            endpoint,
            enabled: AtomicBool::new(enabled),
            queue: Mutex::new(VecDeque::new()),
            ready: tokio::sync::Notify::new(),
            clients: AtomicUsize::new(0),
            _ownership: ownership,
        });
        service.publish(enabled)?;
        let state = service.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(stream) => stream,
                    Err(e) => {
                        eprintln!("Local control accept: {e}");
                        break;
                    }
                };
                if state.clients.fetch_add(1, Ordering::SeqCst) >= 8 {
                    state.clients.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let state = state.clone();
                std::thread::spawn(move || {
                    let result = state.handle(&mut stream);
                    let response = result.unwrap_or_else(|error| json!({"error":error}));
                    if let Err(e) = write_message(&mut stream, &response) {
                        eprintln!("Local control response: {e}");
                    }
                    state.clients.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        Ok(service)
    }
    fn publish(&self, enabled: bool) -> Result<(), String> {
        let path = self.root.join("endpoint.json");
        if enabled {
            write_private(
                &path,
                &serde_json::to_value(&self.endpoint).map_err(|e| e.to_string())?,
            )
        } else {
            match std::fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        }
    }
    fn handle(&self, stream: &mut TcpStream) -> Result<Value, String> {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        let value = read_message(stream)?;
        if !self.enabled.load(Ordering::SeqCst)
            || value["version"] != 1
            || value["token"].as_str() != Some(&self.endpoint.token)
        {
            return Err("Local control is disabled or authentication failed".into());
        }
        let method = value["method"].as_str().ok_or("Missing method")?;
        if ![
            "status",
            "projects.list",
            "sessions.list",
            "sessions.new",
            "sessions.focus",
            "sessions.send",
            "sessions.close",
            "open",
        ]
        .contains(&method)
        {
            return Err("Unknown control method".into());
        }
        let request = Request {
            id: uuid::Uuid::new_v4().to_string(),
            method: method.into(),
            params: value["params"].clone(),
        };
        let id = request.id.clone();
        let (send, receive) = mpsc::sync_channel(1);
        {
            let mut queue = self.queue.lock().map_err(|e| e.to_string())?;
            queue.retain(|p| p.expires > Instant::now());
            if !self.enabled.load(Ordering::SeqCst) {
                return Err("Local control disabled".into());
            }
            if queue.len() >= 16 {
                return Err("Control queue is busy".into());
            }
            queue.push_back(Pending {
                request,
                expires: Instant::now() + Duration::from_secs(15),
                reply: send,
                claimed: false,
            });
        }
        self.ready.notify_waiters();
        let result = receive
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| "Control request timed out; check the app before retrying".to_string());
        self.queue
            .lock()
            .map_err(|e| e.to_string())?
            .retain(|p| p.request.id != id);
        result
    }
    pub fn open_link(&self, value: &str) -> Result<(), String> {
        valid_link(value)?;
        let (reply, _) = mpsc::sync_channel(1);
        let mut queue = self.queue.lock().map_err(|e| e.to_string())?;
        queue.retain(|pending| pending.expires > Instant::now());
        if queue.len() >= 16 {
            return Err("会话链接队列已满。".into());
        }
        queue.push_back(Pending {
            request: Request {
                id: uuid::Uuid::new_v4().to_string(),
                method: "open".into(),
                params: json!({"url":value}),
            },
            expires: Instant::now() + Duration::from_secs(60),
            reply,
            claimed: false,
        });
        drop(queue);
        self.ready.notify_waiters();
        Ok(())
    }

    async fn wait(&self) -> Result<bool, String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let notified = self.ready.notified();
            tokio::pin!(notified);
            // Register before checking so queued requests cannot race a sleeping renderer.
            // 先登记通知再检查队列，避免请求入队与界面休眠之间的竞态。
            notified.as_mut().enable();
            {
                let mut queue = self.queue.lock().map_err(|error| error.to_string())?;
                queue.retain(|pending| pending.expires > Instant::now());
                if queue.iter().any(|pending| !pending.claimed) {
                    return Ok(true);
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Ok(false);
            }
        }
    }
}
#[tauri::command]
pub async fn control_wait(state: tauri::State<'_, Arc<Control>>) -> Result<bool, String> {
    state.inner().clone().wait().await
}
#[tauri::command]
pub fn control_status(state: tauri::State<'_, Arc<Control>>) -> Value {
    json!({"enabled":state.enabled.load(Ordering::SeqCst),"directory":state.root.parent(),"endpoint":state.root.join("endpoint.json"),"port":state.endpoint.port})
}
#[tauri::command]
pub fn control_configure(
    state: tauri::State<'_, Arc<Control>>,
    enabled: bool,
) -> Result<(), String> {
    write_private(
        &state.root.join("settings.json"),
        &json!({"enabled":enabled}),
    )?;
    state.publish(enabled)?;
    state.enabled.store(enabled, Ordering::SeqCst);
    if !enabled {
        let mut queue = state.queue.lock().map_err(|e| e.to_string())?;
        for pending in queue.drain(..) {
            let _ = pending
                .reply
                .try_send(json!({"error":"Local control disabled"}));
        }
    }
    Ok(())
}
#[tauri::command]
pub fn control_poll(state: tauri::State<'_, Arc<Control>>) -> Result<Option<Request>, String> {
    let mut queue = state.queue.lock().map_err(|e| e.to_string())?;
    queue.retain(|p| p.expires > Instant::now());
    if let Some(pending) = queue.iter_mut().find(|p| !p.claimed) {
        pending.claimed = true;
        return Ok(Some(pending.request.clone()));
    }
    Ok(None)
}
#[tauri::command]
pub fn control_reply(
    state: tauri::State<'_, Arc<Control>>,
    id: String,
    result: Value,
) -> Result<(), String> {
    let mut queue = state.queue.lock().map_err(|e| e.to_string())?;
    if let Some(index) = queue.iter().position(|p| p.request.id == id) {
        if let Some(pending) = queue.remove(index) {
            let _ = pending.reply.try_send(result);
        }
    }
    Ok(())
}
#[tauri::command]
pub fn control_focus(app: tauri::AppHandle) -> Result<(), String> {
    crate::show_main_window(&app)
}
#[tauri::command]
pub fn control_install(app: tauri::AppHandle) -> Result<String, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let bin = directory.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let path = bin.join(if cfg!(windows) { "uterm.cmd" } else { "uterm" });
    let exe = executable.to_str().ok_or("程序路径无法转换为文本。")?;
    let root = directory.to_str().ok_or("设置目录无法转换为文本。")?;
    let script = if cfg!(windows) {
        format!("@echo off\r\nstart /wait \"\" \"{}\" --control --data-dir \"{}\" %*\r\nexit /b %errorlevel%\r\n", exe.replace('%', "%%"), root.replace('%', "%%"))
    } else {
        let quote = |text: &str| format!("'{}'", text.replace('\'', "'\\''"));
        format!(
            "#!/bin/sh\nexec {} --control --data-dir {} \"$@\"\n",
            quote(exe),
            quote(root)
        )
    };
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn service(directory: &Path) -> Arc<Control> {
        Arc::new(Control {
            root: directory.to_owned(),
            endpoint: Endpoint {
                version: 1,
                port: 0,
                token: "test-token".into(),
            },
            enabled: AtomicBool::new(true),
            queue: Mutex::new(VecDeque::new()),
            ready: tokio::sync::Notify::new(),
            clients: AtomicUsize::new(0),
            _ownership: private_file(&directory.join("lock")).unwrap(),
        })
    }
    #[test]
    fn control_authentication_and_queued_reply_use_real_sockets() {
        let directory = tempfile::tempdir().unwrap();
        let state = service(directory.path());
        for (token, enabled) in [("wrong", true), ("test-token", false)] {
            state.enabled.store(enabled, Ordering::SeqCst);
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            write_message(
                &mut client,
                &json!({"version":1,"token":token,"method":"status"}),
            )
            .unwrap();
            let mut server = listener.accept().unwrap().0;
            assert!(state
                .handle(&mut server)
                .unwrap_err()
                .contains("authentication"));
            assert!(state.queue.lock().unwrap().is_empty());
        }
        state.enabled.store(true, Ordering::SeqCst);
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        write_message(&mut client, &json!({"version":1,"token":"test-token","method":"sessions.send","params":{"id":"test","text":"中文\r"}})).unwrap();
        let worker = state.clone();
        let handle = std::thread::spawn(move || worker.handle(&mut listener.accept().unwrap().0));
        let started = Instant::now();
        loop {
            if let Some(pending) = state.queue.lock().unwrap().pop_front() {
                assert_eq!(pending.request.params["text"], "中文\r");
                pending.reply.send(json!({"result":{"id":"test"}})).unwrap();
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(3));
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(handle.join().unwrap().unwrap()["result"]["id"], "test");
    }
    #[test]
    fn idle_waiters_wake_without_claiming_requests_or_losing_a_reloaded_view() {
        let directory = tempfile::tempdir().unwrap();
        let state = service(directory.path());
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let first = state.wait();
                let reloaded = state.wait();
                tokio::pin!(first, reloaded);
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), first.as_mut())
                        .await
                        .is_err()
                );
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), reloaded.as_mut())
                        .await
                        .is_err()
                );
                state.enabled.store(false, Ordering::SeqCst);
                state
                    .open_link("uterm://session/12345678-1234-1234-1234-123456789abc")
                    .unwrap();
                assert!(tokio::time::timeout(Duration::from_secs(1), first)
                    .await
                    .unwrap()
                    .unwrap());
                assert!(tokio::time::timeout(Duration::from_secs(1), reloaded)
                    .await
                    .unwrap()
                    .unwrap());
                assert_eq!(state.queue.lock().unwrap().len(), 1);
                assert!(!state.queue.lock().unwrap()[0].claimed);
                assert!(state.wait().await.unwrap());
                state.queue.lock().unwrap()[0].claimed = true;
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), state.wait())
                        .await
                        .is_err()
                );
                state.queue.lock().unwrap()[0].expires = Instant::now() - Duration::from_secs(1);
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), state.wait())
                        .await
                        .is_err()
                );
                assert!(state.queue.lock().unwrap().is_empty());
                for _ in 0..16 {
                    state
                        .open_link("uterm://session/12345678-1234-1234-1234-123456789abc")
                        .unwrap();
                }
                for pending in state.queue.lock().unwrap().iter_mut() {
                    pending.expires = Instant::now() - Duration::from_secs(1);
                }
                state
                    .open_link("uterm://session/12345678-1234-1234-1234-123456789abc")
                    .unwrap();
                assert_eq!(state.queue.lock().unwrap().len(), 1);
            });
    }
    #[test]
    fn oversized_messages_are_rejected_before_dispatch() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let worker = std::thread::spawn(move || read_message(&mut listener.accept().unwrap().0));
        client.write_all(&vec![b'x'; LIMIT as usize + 1]).unwrap();
        assert!(worker.join().unwrap().unwrap_err().contains("oversized"));
    }
    #[test]
    fn links_only_select_sessions() {
        assert!(valid_link("uterm://session/12345678-1234-1234-1234-123456789abc").is_ok());
        for value in [
            "uterm://session/123?command=rm",
            "https://session/123",
            "uterm://session/../new",
            "uterm://session/12345678-1234-1234-1234-123456789abc#extra",
        ] {
            assert!(valid_link(value).is_err());
        }
    }
    #[test]
    fn help_text_as_a_send_argument_does_not_trigger_cli_help() {
        let directory = tempfile::tempdir().expect("profile");
        let result = cli(vec![
            "--data-dir".into(),
            directory.path().to_string_lossy().into_owned(),
            "sessions".into(),
            "send".into(),
            "id".into(),
            "--help".into(),
        ]);
        assert!(result
            .expect_err("must attempt dispatch")
            .contains("endpoint not found"));
    }
    #[test]
    fn sending_requires_explicit_enter() {
        assert!(cli(vec![
            "--data-dir".into(),
            "missing-profile".into(),
            "--help".into()
        ])
        .unwrap()["usage"]
            .is_string());
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            parse_arguments(&args(&["sessions", "send", "id", "hello world"]))
                .unwrap()
                .1["text"],
            "hello world"
        );
        assert_eq!(
            parse_arguments(&args(&["sessions", "send", "id", "hello", "--enter"]))
                .unwrap()
                .1["text"],
            "hello\r"
        );
        assert!(parse_arguments(&args(&["sessions", "close", "id", "extra"])).is_err());
    }
}
