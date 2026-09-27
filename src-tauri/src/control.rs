use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

const LIMIT: u64 = 128 * 1024;
#[derive(Clone, Serialize, Deserialize)]
struct Endpoint {
    version: u8,
    port: u16,
    token: String,
}
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
fn read_message(stream: &mut TcpStream) -> Result<Value, String> {
    let mut bytes = Vec::new();
    BufReader::new(stream.take(LIMIT + 1))
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT || bytes.last() != Some(&b'\n') {
        return Err("Invalid or oversized control message".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
fn write_message(stream: &mut TcpStream, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stream, value).map_err(|e| e.to_string())?;
    stream.write_all(b"\n").map_err(|e| e.to_string())
}
pub fn valid_link(value: &str) -> Result<String, String> {
    let url = tauri::Url::parse(value).map_err(|_| "会话链接无效。")?;
    if !["uterm", "uterm"].contains(&url.scheme())
        || url.host_str() != Some("session")
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("会话链接无效。".into());
    }
    let id = url.path().strip_prefix('/').ok_or("会话链接无效。")?;
    if uuid::Uuid::parse_str(id).is_err() || id.len() != 36 {
        return Err("会话链接无效。".into());
    }
    Ok(id.into())
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
        Ok(())
    }
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
pub fn cli(mut args: Vec<String>) -> Result<Value, String> {
    if args.is_empty()
        || args == ["--help"]
        || (args.len() == 3 && args[0] == "--data-dir" && args[2] == "--help")
    {
        return Ok(
            json!({"usage":"uterm [--data-dir PATH] status | projects list | sessions list | sessions new DIRECTORY [AGENT] | sessions focus ID | sessions send ID TEXT [--enter] | sessions close ID | open URL","note":"Enable local control in Settings. The desktop app must be running. Send writes exactly the supplied text; --enter adds a carriage return."}),
        );
    }
    let directory = if args.first().is_some_and(|a| a == "--data-dir") {
        if args.len() < 3 {
            return Err("Missing data directory or command".into());
        }
        let path = PathBuf::from(args.remove(1));
        args.remove(0);
        path
    } else if let Some(path) = std::env::var_os("UTERM_DESKTOP_DATA") {
        path.into()
    } else {
        #[cfg(target_os = "macos")]
        let base = PathBuf::from(std::env::var_os("HOME").ok_or("Missing HOME")?)
            .join("Library/Application Support");
        #[cfg(windows)]
        let base = PathBuf::from(std::env::var_os("APPDATA").ok_or("Missing APPDATA")?);
        #[cfg(not(any(windows, target_os = "macos")))]
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share")
            });
        base.join("sh.uterm.desktop.dev")
    };
    let (method, params) = parse_arguments(&args)?;
    let endpoint: Endpoint = serde_json::from_slice(
        &std::fs::read(directory.join("control-v1/endpoint.json")).map_err(|_| {
            "Local control endpoint not found; start the app and enable local control"
        })?,
    )
    .map_err(|e| e.to_string())?;
    if endpoint.version != 1 {
        return Err("Unsupported control protocol".into());
    }
    let mut stream = TcpStream::connect_timeout(
        &([127, 0, 0, 1], endpoint.port).into(),
        Duration::from_secs(2),
    )
    .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(17)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    write_message(
        &mut stream,
        &json!({"version":1,"token":endpoint.token,"method":method,"params":params}),
    )?;
    let reply = read_message(&mut stream)?;
    if let Some(error) = reply["error"].as_str() {
        Err(error.into())
    } else {
        Ok(reply["result"].clone())
    }
}
fn parse_arguments(args: &[String]) -> Result<(&str, Value), String> {
    let values: Vec<&str> = args.iter().map(String::as_str).collect();
    match values.as_slice() {
        ["status"] => Ok(("status", json!({}))),
        ["projects", "list"] => Ok(("projects.list", json!({}))),
        ["sessions", "list"] => Ok(("sessions.list", json!({}))),
        ["sessions", "new", path] => Ok(("sessions.new", json!({"directory":path}))),
        ["sessions", "new", path, agent] => {
            Ok(("sessions.new", json!({"directory":path,"agent":agent})))
        }
        ["sessions", "focus", id] => Ok(("sessions.focus", json!({"id":id}))),
        ["sessions", "close", id] => Ok(("sessions.close", json!({"id":id}))),
        ["sessions", "send", id, text] => Ok(("sessions.send", json!({"id":id,"text":text}))),
        ["sessions", "send", id, text, "--enter"] => {
            Ok(("sessions.send", json!({"id":id,"text":format!("{text}\r")})))
        }
        ["open", url] => {
            valid_link(url)?;
            Ok(("open", json!({"url":url})))
        }
        _ => Err("Invalid arguments; use --help".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_authentication_and_queued_reply_use_real_sockets() {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(Control {
            root: directory.path().to_owned(),
            endpoint: Endpoint {
                version: 1,
                port: 0,
                token: "test-token".into(),
            },
            enabled: AtomicBool::new(true),
            queue: Mutex::new(VecDeque::new()),
            clients: AtomicUsize::new(0),
            _ownership: private_file(&directory.path().join("lock")).unwrap(),
        });
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
