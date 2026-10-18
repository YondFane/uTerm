use crate::BackgroundChild;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tungstenite::{client::IntoClientRequest, Message, WebSocket};

pub(crate) struct Launch {
    pub arguments: Vec<String>,
    pub environment: Vec<(String, String)>,
    pub observer: Option<Observer>,
}

pub(crate) enum Observer {
    Codex {
        child: BackgroundChild,
        token_file: PathBuf,
        token: String,
        address: String,
    },
    OpenCode {
        address: String,
        password: String,
    },
}

impl Drop for Observer {
    fn drop(&mut self) {
        if let Self::Codex { token_file, .. } = self {
            let _ = std::fs::remove_file(token_file);
        }
    }
}

fn port() -> Result<u16> {
    Ok(TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?
        .local_addr()?
        .port())
}

fn supports_remote(program: &Path) -> Result<bool> {
    let mut command = crate::process::background_command(program, &["--help".into()]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = BackgroundChild::spawn(&mut command)?;
    let stdout = child.take_stdout().context("Missing CLI help output")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = vec![];
        let _ = stdout.take(256 * 1024).read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).contains("--remote-auth-token-env")
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while child.try_wait()?.is_none() {
        if Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Ok(reader.join().unwrap_or(false))
}

pub(crate) fn prepare(
    agent: &str,
    program: &Path,
    mut arguments: Vec<String>,
    directory: &Path,
    host: &Path,
) -> Result<Launch> {
    if explicit_command(agent, &arguments) {
        return Ok(Launch {
            arguments,
            environment: vec![],
            observer: None,
        });
    }
    let mut environment = vec![];
    let observer = match agent {
        "codex"
            if !arguments
                .iter()
                .any(|arg| arg == "--remote" || arg.starts_with("--remote=")) =>
        {
            if codex_needs_local_configuration(&arguments) || !supports_remote(program)? {
                arguments.splice(
                    0..0,
                    [
                        "-c".into(),
                        "tui.notifications=true".into(),
                        "-c".into(),
                        "tui.notification_method=osc9".into(),
                    ],
                );
                None
            } else {
                let address = format!("ws://127.0.0.1:{}", port()?);
                let token = uuid::Uuid::new_v4().to_string() + &uuid::Uuid::new_v4().to_string();
                std::fs::create_dir_all(host)?;
                let token_file = host.join(format!("activity-{}.token", uuid::Uuid::new_v4()));
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                use std::io::Write;
                options.open(&token_file)?.write_all(token.as_bytes())?;
                let mut command = crate::process::background_command(
                    program,
                    &[
                        "app-server".into(),
                        "--listen".into(),
                        address.clone(),
                        "--ws-auth".into(),
                        "capability-token".into(),
                        "--ws-token-file".into(),
                        token_file.to_string_lossy().into(),
                    ],
                );
                command
                    .current_dir(directory)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                let child = match BackgroundChild::spawn(&mut command) {
                    Ok(child) => child,
                    Err(error) => {
                        let _ = std::fs::remove_file(&token_file);
                        return Err(error);
                    }
                };
                let observer = Observer::Codex {
                    child,
                    token_file,
                    token: token.clone(),
                    address: address.clone(),
                };
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    if connect(&address, &token).is_ok() {
                        break;
                    }
                    if Instant::now() >= deadline {
                        bail!("Codex event server did not become ready");
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let boundary = arguments
                    .iter()
                    .position(|arg| arg == "--")
                    .unwrap_or(arguments.len());
                arguments = arguments
                    .into_iter()
                    .enumerate()
                    .filter_map(|(index, arg)| {
                        (index >= boundary || arg != "--no-daemon").then_some(arg)
                    })
                    .collect();
                arguments.splice(
                    0..0,
                    [
                        "--remote".into(),
                        address,
                        "--remote-auth-token-env".into(),
                        "UTERM_CODEX_ACTIVITY_TOKEN".into(),
                        "-c".into(),
                        "tui.notifications=true".into(),
                        "-c".into(),
                        "tui.notification_method=osc9".into(),
                        "-c".into(),
                        "tui.notification_condition=always".into(),
                    ],
                );
                environment.push(("UTERM_CODEX_ACTIVITY_TOKEN".into(), token));
                Some(observer)
            }
        }
        "claude" => {
            arguments.splice(
                0..0,
                [
                    "--settings".into(),
                    r#"{"preferredNotifChannel":"terminal_bell"}"#.into(),
                ],
            );
            None
        }
        "opencode"
            if !arguments.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "attach" | "serve" | "web" | "--port" | "--hostname" | "--mdns"
                ) || arg.starts_with("--port=")
                    || arg.starts_with("--hostname=")
            }) =>
        {
            let address = format!("http://127.0.0.1:{}", port()?);
            let password = uuid::Uuid::new_v4().to_string();
            arguments.splice(
                0..0,
                [
                    "--hostname".into(),
                    "127.0.0.1".into(),
                    "--port".into(),
                    address.rsplit(':').next().unwrap().into(),
                ],
            );
            environment.push(("OPENCODE_SERVER_USERNAME".into(), "uterm".into()));
            environment.push(("OPENCODE_SERVER_PASSWORD".into(), password.clone()));
            Some(Observer::OpenCode { address, password })
        }
        _ => None,
    };
    Ok(Launch {
        arguments,
        environment,
        observer,
    })
}

fn codex_needs_local_configuration(arguments: &[String]) -> bool {
    // A separate server cannot inherit invocation-only profiles and config overrides.
    // 独立服务无法继承仅用于本次启动的配置档和覆盖设置。
    arguments
        .iter()
        .take_while(|arg| arg.as_str() != "--")
        .any(|arg| {
            matches!(
                arg.as_str(),
                "-c" | "--config"
                    | "-p"
                    | "--profile"
                    | "--oss"
                    | "--local-provider"
                    | "-C"
                    | "--cd"
                    | "--worktree"
                    | "--enable"
                    | "--disable"
                    | "--strict-config"
            ) || [
                "--config=",
                "--profile=",
                "--local-provider=",
                "--cd=",
                "--enable=",
                "--disable=",
            ]
            .iter()
            .any(|prefix| arg.starts_with(prefix))
                || (arg.len() > 2
                    && ["-c", "-p", "-C"]
                        .iter()
                        .any(|prefix| arg.starts_with(prefix)))
        })
}

fn explicit_command(agent: &str, arguments: &[String]) -> bool {
    let commands: &[&str] = match agent {
        "codex" => &[
            "exec",
            "e",
            "review",
            "login",
            "logout",
            "mcp",
            "plugin",
            "app-server",
            "remote-control",
            "app",
            "completion",
            "update",
            "doctor",
            "sandbox",
            "debug",
            "apply",
            "agents",
            "queue",
            "archive",
            "delete",
            "unarchive",
            "migrate-rollouts",
            "cloud",
            "exec-server",
            "features",
            "help",
        ],
        "opencode" => &[
            "completion",
            "acp",
            "mcp",
            "attach",
            "run",
            "debug",
            "providers",
            "auth",
            "agent",
            "upgrade",
            "uninstall",
            "serve",
            "web",
            "models",
            "stats",
            "export",
            "import",
            "github",
            "pr",
            "session",
            "plugin",
            "db",
            "help",
        ],
        _ => return false,
    };
    let mut remaining = arguments.iter();
    while let Some(argument) = remaining.next() {
        if argument == "--" {
            break;
        }
        if matches!(argument.as_str(), "--help" | "-h" | "--version" | "-V") {
            return true;
        }
        if agent == "opencode" && matches!(argument.as_str(), "-c" | "--continue" | "--fork") {
            continue;
        }
        if matches!(
            argument.as_str(),
            "-c" | "--config"
                | "--model"
                | "-m"
                | "--profile"
                | "-p"
                | "--cd"
                | "-C"
                | "--add-dir"
                | "--sandbox"
                | "-s"
                | "--ask-for-approval"
                | "-a"
                | "--image"
                | "-i"
                | "--enable"
                | "--disable"
                | "--hostname"
                | "--port"
                | "--agent"
        ) {
            remaining.next();
            continue;
        }
        if !argument.starts_with('-') {
            return commands.contains(&argument.as_str());
        }
    }
    false
}

fn connect(address: &str, token: &str) -> Result<WebSocket<TcpStream>> {
    let port: u16 = address
        .rsplit(':')
        .next()
        .context("Missing port")?
        .parse()?;
    let stream =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(1))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut request = address.into_client_request()?;
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {token}").parse()?);
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(16 * 1024 * 1024))
        .max_frame_size(Some(16 * 1024 * 1024));
    Ok(tungstenite::client::client_with_config(request, stream, Some(config))?.0)
}

fn rpc(
    socket: &mut WebSocket<TcpStream>,
    id: &mut u64,
    method: &str,
    params: Value,
) -> Result<Value> {
    *id += 1;
    socket.send(Message::Text(
        json!({"id": id, "method": method, "params": params})
            .to_string()
            .into(),
    ))?;
    loop {
        match socket.read()? {
            Message::Text(text) => {
                let response: Value = serde_json::from_str(&text)?;
                if response["id"].as_u64() == Some(*id) {
                    if response.get("error").is_some() {
                        bail!("{method}: {}", response["error"]["message"]);
                    }
                    return Ok(response["result"].clone());
                }
            }
            Message::Ping(bytes) => socket.send(Message::Pong(bytes))?,
            Message::Close(_) => bail!("Agent event connection closed"),
            _ => {}
        }
    }
}

fn legacy_turns(history: &Value) -> Result<Vec<Value>> {
    let mut turns = history["thread"]["turns"]
        .as_array()
        .context("Missing Codex turns")?
        .clone();
    // Match the newest-first order of thread/turns/list.
    // 与 thread/turns/list 的从新到旧顺序保持一致。
    turns.reverse();
    Ok(turns)
}

#[derive(Default)]
struct CodexState {
    turns: HashMap<String, HashSet<String>>,
    states: HashMap<String, String>,
    refreshed: HashMap<String, (Value, Instant)>,
}

impl CodexState {
    fn refresh_history(&mut self, thread: &Value, hint: bool) -> bool {
        let Some(id) = thread["id"].as_str() else {
            return false;
        };
        let signature = json!([thread["updatedAt"], thread["status"]]);
        if !hint
            && self.refreshed.get(id).is_some_and(|(previous, time)| {
                previous == &signature && time.elapsed() < Duration::from_secs(5)
            })
        {
            return false;
        }
        self.refreshed
            .insert(id.into(), (signature, Instant::now()));
        true
    }

    fn update(&mut self, thread: &Value, turns: &[Value], emit: &mut impl FnMut(&str)) {
        let Some(id) = thread["id"].as_str() else {
            return;
        };
        if thread["ephemeral"] == true
            || thread["parentThreadId"].as_str().is_some()
            || thread["source"].get("subAgent").is_some()
        {
            return;
        }
        let first = !self.turns.contains_key(id);
        let seen = self.turns.entry(id.into()).or_default();
        for turn in turns.iter().rev() {
            let (Some(turn_id), Some(status)) = (turn["id"].as_str(), turn["status"].as_str())
            else {
                continue;
            };
            if status != "inProgress" && seen.insert(turn_id.into()) && !first {
                emit(match status {
                    "completed" => "done",
                    "failed" => "error",
                    _ => "idle",
                });
            }
        }
        let state = if thread["status"]["type"] == "active" {
            if thread["status"]["activeFlags"]
                .as_array()
                .is_some_and(|flags| {
                    flags.iter().any(|flag| {
                        matches!(
                            flag.as_str(),
                            Some("waitingOnApproval" | "waitingOnUserInput")
                        )
                    })
                })
            {
                "waiting"
            } else {
                "working"
            }
        } else if thread["status"]["type"] == "systemError" {
            "error"
        } else {
            "idle"
        };
        let previous = self.states.insert(id.into(), state.into());
        if previous.as_deref() != Some(state) && state != "idle" {
            emit(state);
        }
    }
}

pub(crate) fn observe(
    mut observer: Observer,
    mut alive: impl FnMut() -> bool,
    mut hint: impl FnMut() -> bool,
    mut emit: impl FnMut(&str),
    mut failure: impl FnMut(Option<String>),
) {
    let mut codex = CodexState::default();
    let mut opencode = OpenCodeState::default();
    let mut legacy = HashSet::new();
    let started = Instant::now();
    let mut connected_once = false;
    while alive() {
        let result = match &mut observer {
            Observer::Codex {
                address,
                token,
                child,
                ..
            } => {
                if child.try_wait().ok().flatten().is_some() {
                    failure(Some("Codex 事件服务已退出。".into()));
                    break;
                }
                (|| -> Result<()> {
                    let mut socket = connect(address, token)?;
                    let mut id = 0;
                    rpc(
                        &mut socket,
                        &mut id,
                        "initialize",
                        json!({"clientInfo":{"name":"uterm_activity","version":"1.0"}}),
                    )?;
                    socket.send(Message::Text(
                        json!({"method":"initialized","params":{}})
                            .to_string()
                            .into(),
                    ))?;
                    connected_once = true;
                    while alive() {
                        let loaded = rpc(&mut socket, &mut id, "thread/loaded/list", json!({}))?;
                        for thread_id in loaded["data"].as_array().into_iter().flatten().take(128) {
                            if !alive() {
                                break;
                            }
                            let thread_id =
                                thread_id.as_str().context("Invalid Codex thread ID")?;
                            let thread = match rpc(
                                &mut socket,
                                &mut id,
                                "thread/read",
                                json!({"threadId":thread_id}),
                            ) {
                                Ok(value) => value,
                                Err(error)
                                    if error.to_string().contains("session metadata")
                                        && error.to_string().contains("is empty") =>
                                {
                                    continue
                                }
                                Err(error) => return Err(error),
                            };
                            if thread["thread"]["ephemeral"] == true
                                || thread["thread"]["parentThreadId"].as_str().is_some()
                            {
                                continue;
                            }
                            let refresh = codex.refresh_history(&thread["thread"], hint());
                            if legacy.contains(thread_id) && !refresh {
                                codex.update(&thread["thread"], &[], &mut emit);
                                continue;
                            }
                            let turns = match rpc(
                                &mut socket,
                                &mut id,
                                "thread/turns/list",
                                json!({"threadId":thread_id,"limit":100,"itemsView":"notLoaded"}),
                            ) {
                                Ok(value) => value,
                                Err(error)
                                    if error.to_string().contains("not materialized yet") =>
                                {
                                    json!({"data":[]})
                                }
                                Err(error)
                                    if error
                                        .to_string()
                                        .contains("list_turns is not supported yet") =>
                                {
                                    legacy.insert(thread_id.to_owned());
                                    let history = rpc(
                                        &mut socket,
                                        &mut id,
                                        "thread/read",
                                        json!({"threadId":thread_id,"includeTurns":true}),
                                    )?;
                                    json!({"data":legacy_turns(&history)?})
                                }
                                Err(error) => return Err(error),
                            };
                            codex.update(
                                &thread["thread"],
                                turns["data"].as_array().context("Missing Codex turns")?,
                                &mut emit,
                            );
                        }
                        failure(None);
                        std::thread::sleep(Duration::from_millis(500));
                    }
                    Ok(())
                })()
            }
            Observer::OpenCode { address, password } => (|| -> Result<()> {
                let client = reqwest::blocking::Client::builder()
                    .no_proxy()
                    .connect_timeout(Duration::from_secs(1))
                    .timeout(None)
                    .redirect(reqwest::redirect::Policy::none())
                    .build()?;
                let response = client
                    .get(format!("{address}/event"))
                    .basic_auth("uterm", Some(password.as_str()))
                    .send()?
                    .error_for_status()?;
                connected_once = true;
                failure(None);
                let mut reader = BufReader::new(response);
                let mut data = String::new();
                let mut line = String::new();
                while alive() {
                    line.clear();
                    if reader.by_ref().take(256 * 1024).read_line(&mut line)? == 0 {
                        break;
                    }
                    if line.len() >= 256 * 1024 {
                        bail!("Oversized OpenCode event");
                    }
                    if line.trim().is_empty() {
                        if !data.is_empty() {
                            let event: Value = serde_json::from_str(&data)?;
                            let session_id = event["properties"]["sessionID"].as_str();
                            if let Some(id) = session_id {
                                if !opencode.roots.contains_key(id) {
                                    let session: Value = client
                                        .get(format!("{address}/session/{id}"))
                                        .basic_auth("uterm", Some(password.as_str()))
                                        .timeout(Duration::from_secs(2))
                                        .send()?
                                        .error_for_status()?
                                        .json()?;
                                    opencode
                                        .roots
                                        .insert(id.into(), session["parentID"].as_str().is_none());
                                }
                            }
                            if session_id.is_none_or(|id| opencode.roots.get(id) == Some(&true)) {
                                opencode.update(&event, &mut emit);
                            }
                            data.clear();
                        }
                    } else if let Some(value) = line.strip_prefix("data:") {
                        if data.len() + value.len() > 256 * 1024 {
                            bail!("Oversized OpenCode event");
                        }
                        data.push_str(value.trim());
                    }
                }
                Ok(())
            })(),
        };
        if let Err(error) = result {
            let message = format!("Agent 事件连接失败：{error}");
            if connected_once || started.elapsed() > Duration::from_secs(10) {
                failure(Some(message.clone()));
            }
        }
        if alive() {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

#[derive(Default)]
struct OpenCodeState {
    sessions: HashMap<String, String>,
    roots: HashMap<String, bool>,
}
impl OpenCodeState {
    fn update(&mut self, event: &Value, emit: &mut impl FnMut(&str)) {
        let props = &event["properties"];
        match event["type"].as_str() {
            Some("session.status") => {
                if let (Some(id), Some(status)) = (
                    props["sessionID"].as_str(),
                    props["status"]["type"].as_str(),
                ) {
                    let previous = self.sessions.insert(id.into(), status.into());
                    if previous.as_deref() != Some(status) {
                        match status {
                            "busy" | "retry" => emit("working"),
                            "idle"
                                if previous
                                    .is_some_and(|state| state == "busy" || state == "retry") =>
                            {
                                emit("done")
                            }
                            _ => {}
                        }
                    }
                }
            }
            Some("permission.asked" | "question.asked") => emit("waiting"),
            Some("permission.replied" | "question.replied" | "question.rejected") => {
                emit("working")
            }
            Some("session.error") => {
                if let Some(id) = props["sessionID"].as_str() {
                    self.sessions.insert(id.into(), "error".into());
                }
                emit("error");
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_sse_authenticates_filters_children_and_keeps_failures_distinct() {
        use std::io::Write;
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let server_alive = running.clone();
        let server = std::thread::spawn(move || {
            while server_alive.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        std::thread::spawn(move || {
                            stream
                                .set_read_timeout(Some(Duration::from_secs(1)))
                                .unwrap();
                            let mut request = String::new();
                            let mut reader = BufReader::new(stream.try_clone().unwrap());
                            loop {
                                let mut line = String::new();
                                if reader.read_line(&mut line).unwrap() == 0 {
                                    return;
                                }
                                request.push_str(&line);
                                if line == "\r\n" {
                                    break;
                                }
                            }
                            assert!(request
                                .to_ascii_lowercase()
                                .contains("authorization: basic dxrlcm06cgfzc3dvcmq="));
                            let body = if request.starts_with("GET /session/child ") {
                                json!({"id":"child","parentID":"main"}).to_string()
                            } else if request.starts_with("GET /session/main ") {
                                json!({"id":"main"}).to_string()
                            } else {
                                assert!(request.starts_with("GET /event "));
                                let status = |id, kind| json!({"type":"session.status","properties":{"sessionID":id,"status":{"type":kind}}});
                                [status("child","busy"), status("child","idle"), status("main","busy"),
                                json!({"type":"permission.asked","properties":{"sessionID":"main"}}),
                                json!({"type":"permission.replied","properties":{"sessionID":"main"}}),
                                json!({"type":"session.error","properties":{"sessionID":"main"}}),
                                status("main","idle"),status("main","busy"),status("main","idle")]
                                .into_iter().map(|event| format!("data: {event}\n\n")).collect::<String>()
                            };
                            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                            let _ = stream.write_all(response.as_bytes());
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        });
        let alive = running.clone();
        let stopped = running.clone();
        let started = Instant::now();
        let mut events = vec![];
        let mut errors = vec![];
        observe(
            Observer::OpenCode {
                address,
                password: "password".into(),
            },
            move || alive.load(Ordering::Acquire) && started.elapsed() < Duration::from_secs(3),
            || false,
            |kind| {
                events.push(kind.to_owned());
                if kind == "done" {
                    stopped.store(false, Ordering::Release);
                }
            },
            |error| {
                if let Some(error) = error {
                    errors.push(error);
                }
            },
        );
        running.store(false, Ordering::Release);
        server.join().unwrap();
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(
            events,
            ["working", "waiting", "working", "error", "working", "done"]
        );
    }

    #[test]
    fn codex_custom_invocation_keeps_its_configuration_with_terminal_reminders() {
        for option in [
            "--profile",
            "--config=model_provider=fixture",
            "-clocal=true",
            "--worktree",
            "-C",
        ] {
            let arguments = vec![option.to_owned(), "value".into()];
            let launch = prepare(
                "codex",
                Path::new("not-used"),
                arguments.clone(),
                Path::new("."),
                Path::new("."),
            )
            .unwrap();
            assert!(launch.observer.is_none());
            assert!(launch.environment.is_empty());
            assert!(launch.arguments.ends_with(&arguments));
        }
        assert!(!codex_needs_local_configuration(&[
            "--".into(),
            "--profile".into()
        ]));
        assert!(!codex_needs_local_configuration(&[
            "--model".into(),
            "qa".into(),
            "--no-daemon".into()
        ]));
    }

    #[test]
    fn explicit_commands_and_literal_option_values_keep_their_launch_semantics() {
        let args = |values: &[&str]| {
            values
                .iter()
                .map(|value| (*value).to_owned())
                .collect::<Vec<_>>()
        };
        assert!(explicit_command(
            "codex",
            &args(&["--no-daemon", "exec", "prompt"])
        ));
        assert!(!explicit_command(
            "codex",
            &args(&["--model", "exec", "resume", "--last"])
        ));
        assert!(!explicit_command("codex", &args(&["--", "exec"])));
        assert!(explicit_command("opencode", &args(&["run", "prompt"])));
        assert!(explicit_command(
            "opencode",
            &args(&["-c", "run", "prompt"])
        ));
        assert!(!explicit_command(
            "opencode",
            &args(&["--model", "run", "D:/project with spaces"])
        ));
        assert!(!explicit_command("custom", &args(&["exec"])));
    }

    #[test]
    #[ignore = "Runs the installed OpenCode TUI in an isolated data directory without model requests"]
    fn installed_opencode_authenticates_its_event_server() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/native-opencode")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let program = crate::process::resolve_program("opencode").unwrap();
        let launch = prepare("opencode", &program, vec![], &root, &root).unwrap();
        let (address, password) = match launch.observer.as_ref().unwrap() {
            Observer::OpenCode { address, password } => (address.clone(), password.clone()),
            _ => panic!("wrong observer"),
        };
        let mut command = crate::process::launch_resolved(&program, &launch.arguments).unwrap();
        for (key, value) in launch.environment {
            command.env(key, value);
        }
        for key in [
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "XDG_STATE_HOME",
        ] {
            command.env(key, root.join(key));
        }
        command.env(
            "OPENCODE_CONFIG_CONTENT",
            r#"{"autoupdate":false,"share":"disabled"}"#,
        );
        let screen = std::sync::Arc::new(std::sync::Mutex::new(vt100::Parser::new_with_callbacks(
            30,
            100,
            1000,
            crate::daemon::TerminalReplies::default(),
        )));
        let output = screen.clone();
        let (reply, replies) = std::sync::mpsc::channel::<Vec<u8>>();
        let session = std::sync::Arc::new(
            crate::Session::spawn_background(command, &root, 30, 100, move |event| {
                if let crate::Event::Output { data, .. } = event {
                    let mut parser = output.lock().unwrap();
                    parser.process(&data);
                    let data = std::mem::take(&mut parser.callbacks_mut().bytes);
                    if !data.is_empty() {
                        let _ = reply.send(data);
                    }
                }
                Ok(())
            })
            .unwrap(),
        );
        let input = std::sync::Arc::downgrade(&session);
        std::thread::spawn(move || {
            while let Ok(data) = replies.recv() {
                if let Some(session) = input.upgrade() {
                    let _ = session.write(data);
                } else {
                    break;
                }
            }
        });
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(
                !session.has_exited(),
                "OpenCode exited: {}",
                screen.lock().unwrap().screen().contents()
            );
            if client
                .get(format!("{address}/global/health"))
                .basic_auth("uterm", Some(&password))
                .send()
                .is_ok_and(|response| response.status().is_success())
            {
                break;
            }
            if Instant::now() >= deadline {
                session.close().unwrap();
                panic!(
                    "OpenCode server not ready: {}",
                    screen.lock().unwrap().screen().contents()
                );
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(
            client
                .get(format!("{address}/global/health"))
                .send()
                .unwrap()
                .status(),
            reqwest::StatusCode::UNAUTHORIZED
        );
        let (ready, connected) = std::sync::mpsc::channel();
        let alive = std::sync::Arc::downgrade(&session);
        let observer = launch.observer.unwrap();
        let task = std::thread::spawn(move || {
            observe(
                observer,
                move || alive.upgrade().is_some_and(|session| !session.has_exited()),
                || false,
                |_| {},
                move |error| {
                    let _ = ready.send(error);
                },
            )
        });
        assert_eq!(
            connected.recv_timeout(Duration::from_secs(10)).unwrap(),
            None
        );
        session.close().unwrap();
        task.join().unwrap();
        println!("Installed OpenCode: authenticated SSE, unauthenticated requests rejected; no provider request");
    }
    #[test]
    fn legacy_codex_history_preserves_the_latest_failure_when_turns_arrive_together() {
        let mut state = CodexState::default();
        let thread = json!({"id":"main","status":{"type":"idle"}});
        let mut events = vec![];
        state.update(&thread, &[], &mut |_| {});
        let history = json!({"thread":{"turns":[
            {"id":"completed","status":"completed"},
            {"id":"failed","status":"failed"}
        ]}});
        let turns = legacy_turns(&history).unwrap();
        for _ in 0..2 {
            state.update(&thread, &turns, &mut |kind| events.push(kind.to_owned()));
        }
        assert_eq!(events, ["done", "error"]);
        assert!(legacy_turns(&json!({})).is_err());
    }

    #[test]
    fn codex_baselines_history_tracks_repeated_turns_and_ignores_subagents() {
        let mut state = CodexState::default();
        let mut events = vec![];
        let mut emit = |event: &str| events.push(event.to_owned());
        let thread = json!({"id":"main","status":{"type":"idle"}});
        state.update(
            &thread,
            &[json!({"id":"old","status":"completed"})],
            &mut emit,
        );
        state.update(
            &thread,
            &[json!({"id":"a","status":"completed"})],
            &mut emit,
        );
        state.update(
            &thread,
            &[json!({"id":"a","status":"completed"})],
            &mut emit,
        );
        state.update(&thread, &[json!({"id":"b","status":"failed"})], &mut emit);
        state.update(
            &thread,
            &[json!({"id":"c","status":"interrupted"})],
            &mut emit,
        );
        state.update(
            &json!({"id":"child","parentThreadId":"main","status":{"type":"active"}}),
            &[],
            &mut emit,
        );
        assert_eq!(events, ["done", "error", "idle"]);
    }
    #[test]
    fn opencode_requires_observed_work_and_does_not_report_errors_as_completed() {
        let mut state = OpenCodeState::default();
        let mut events = vec![];
        for status in ["idle", "busy", "idle", "idle", "busy"] {
            state.update(&json!({"type":"session.status","properties":{"sessionID":"main","status":{"type":status}}}), &mut |kind| events.push(kind.to_owned()));
        }
        state.update(
            &json!({"type":"session.error","properties":{"sessionID":"main"}}),
            &mut |kind| events.push(kind.to_owned()),
        );
        state.update(&json!({"type":"session.status","properties":{"sessionID":"main","status":{"type":"idle"}}}), &mut |kind| events.push(kind.to_owned()));
        assert_eq!(events, ["working", "done", "working", "error"]);
    }
}
