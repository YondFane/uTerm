use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{oneshot, Mutex as AsyncMutex},
};
use utermd_local::BackgroundChild;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    id: String,
    name: String,
    kind: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    tls: bool,
    ca_file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ssh_target: Option<utermd_local::ssh::SshTarget>,
    credential_id: Option<String>,
}
impl Config {
    fn validate(&self) -> Result<()> {
        uuid::Uuid::parse_str(&self.id).context("DB_INVALID_CONFIG")?;
        let clean = |value: &str, limit: usize| {
            value.len() <= limit && !value.chars().any(char::is_control)
        };
        if !["mysql", "postgresql", "oracle"].contains(&self.kind.as_str())
            || self.port == 0
            || self.name.trim().is_empty()
            || !clean(&self.name, 800)
            || !clean(&self.username, 2048)
            || !clean(&self.ca_file, 4096)
            || self.host.is_empty()
            || self.host.starts_with('-')
            || self.host.len() > 255
            || !self
                .host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-:".contains(&c))
            || self.database.len() > 255
            || !self
                .database
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_$.-".contains(&c))
            || (self.kind == "oracle" && self.database.is_empty())
        {
            bail!("DB_INVALID_CONFIG");
        }
        if let Some(target) = &self.ssh_target {
            target.validate()?;
        }
        if let Some(reference) = &self.credential_id {
            uuid::Uuid::parse_str(reference).context("DB_INVALID_CONFIG")?;
        }
        Ok(())
    }
    async fn identity(&self) -> Result<String> {
        let ssh = if let Some(target) = &self.ssh_target {
            crate::ssh::effective_target(target).await?.identity
        } else {
            String::new()
        };
        let ca = if self.tls && !self.ca_file.is_empty() {
            let file = tokio::fs::File::open(&self.ca_file).await?;
            let mut bytes = Vec::new();
            file.take(1048577).read_to_end(&mut bytes).await?;
            if bytes.len() > 1048576 {
                bail!("DB_CA_FAILED");
            }
            format!("{:x}", Sha256::digest(bytes))
        } else {
            String::new()
        };
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &self.kind,
                self.host.to_lowercase(),
                self.port,
                &self.database,
                &self.username,
                self.tls,
                ca,
                ssh
            ))?)
        ))
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
struct Opening<'a>(&'a AtomicUsize);
impl Drop for Opening<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
struct Tunnel(tokio::task::JoinHandle<()>);
impl Drop for Tunnel {
    fn drop(&mut self) {
        self.0.abort();
    }
}
struct Connection {
    browser: Mutex<Option<(String, Arc<Connection>)>>,
    browser_lock: AsyncMutex<()>,
    browser_config: Option<(Config, String, String)>,
    child: Mutex<Option<BackgroundChild>>,
    input: AsyncMutex<tokio::fs::File>,
    pending: Pending,
    sequence: AtomicU64,
    busy: AtomicBool,
    writable: AtomicBool,
    transaction: AtomicBool,
    dead: AtomicBool,
    tunnel: Mutex<Option<Tunnel>>,
    reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
    temporary: Mutex<Option<tempfile::TempDir>>,
}
impl Connection {
    fn stop(&self) {
        self.dead.store(true, Ordering::SeqCst);
        if let Ok(mut browser) = self.browser.lock() {
            if let Some((_, browser)) = browser.take() {
                browser.stop();
            }
        }
        if let Ok(mut child) = self.child.lock() {
            child.take();
        }
        if let Ok(mut tunnel) = self.tunnel.lock() {
            tunnel.take();
        }
        if let Ok(mut reader) = self.reader.lock() {
            if let Some(task) = reader.take() {
                task.abort();
            }
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err("DB_DISCONNECTED".into()));
            }
        }
        if let Ok(mut temporary) = self.temporary.lock() {
            temporary.take();
        }
    }
    async fn send(&self, mut request: Value) -> Result<Value, String> {
        if self.dead.load(Ordering::SeqCst) {
            return Err("DB_DISCONNECTED".into());
        }
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err("DB_BUSY".into());
        }
        let result = async {
            let id = self.sequence.fetch_add(1, Ordering::Relaxed);
            request["id"] = id.into();
            let mut bytes = serde_json::to_vec(&request).map_err(|_| "DB_INVALID_REQUEST")?;
            if bytes.len() > 1048576 {
                return Err("DB_INPUT_LIMIT".into());
            }
            bytes.push(b'\n');
            let (sender, receiver) = oneshot::channel();
            self.pending
                .lock()
                .map_err(|_| "DB_OPERATION_FAILED")?
                .insert(id, sender);
            if !matches!(
                tokio::time::timeout(
                    Duration::from_secs(8),
                    self.input.lock().await.write_all(&bytes)
                )
                .await,
                Ok(Ok(()))
            ) {
                self.stop();
                return Err("DB_DISCONNECTED".into());
            }
            drop(bytes);
            drop(request);
            match tokio::time::timeout(Duration::from_secs(40), receiver).await {
                Ok(Ok(result)) => {
                    if matches!(&result, Err(error) if error == "DB_DISCONNECTED") {
                        self.stop();
                    }
                    result
                }
                _ => {
                    self.stop();
                    Err("DB_TIMEOUT".into())
                }
            }
        }
        .await;
        self.busy.store(false, Ordering::SeqCst);
        result
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Default)]
pub struct DatabaseState {
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    drafts: Mutex<HashSet<String>>,
    opening: AtomicUsize,
}
impl DatabaseState {
    fn reserve(&self) -> Result<Opening<'_>> {
        let mut connections = self
            .connections
            .lock()
            .map_err(|_| anyhow::anyhow!("DB_OPERATION_FAILED"))?;
        connections.retain(|_, connection| !connection.dead.load(Ordering::SeqCst));
        if connections.len() + self.opening.load(Ordering::SeqCst) >= 8 {
            bail!("DB_CONNECTION_LIMIT");
        }
        self.opening.fetch_add(1, Ordering::SeqCst);
        Ok(Opening(&self.opening))
    }
    pub fn in_use(&self) -> bool {
        self.opening.load(Ordering::SeqCst) > 0
            || self.connections.lock().map_or(true, |items| {
                items.values().any(|item| !item.dead.load(Ordering::SeqCst))
            })
    }
    pub fn busy(&self) -> bool {
        self.opening.load(Ordering::SeqCst) > 0
            || self.connections.lock().map_or(true, |items| {
                items.values().any(|item| {
                    item.busy.load(Ordering::SeqCst) || item.transaction.load(Ordering::SeqCst)
                })
            })
    }
    pub fn dirty(&self) -> bool {
        self.drafts.lock().map_or(true, |items| !items.is_empty())
    }
    pub fn stop(&self) {
        if let Ok(mut items) = self.connections.lock() {
            for (_, item) in items.drain() {
                item.stop();
            }
        }
    }
}

async fn socks(app: &tauri::AppHandle, config: &Config) -> Result<(u16, String, Option<Tunnel>)> {
    let Some(target) = config.ssh_target.clone() else {
        return Ok((0, String::new(), None));
    };
    let prepared = crate::ssh_auth::prepare(app, &target).await?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let proxy_token = token.clone();
    let destination = if config.host.contains(':') {
        format!("[{}]:{}", config.host, config.port)
    } else {
        format!("{}:{}", config.host, config.port)
    };
    let task = tokio::spawn(async move {
        // Owning the relays ensures closing a connection also stops its SSH children. 持有转发任务，确保断开连接时一并终止 SSH 子进程。
        let mut relays = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept(), if relays.len() < 4 => {
                    let Ok((socket, _)) = accepted else { break; };
                    let prepared = prepared.clone();
                    let target = target.clone();
                    let destination = destination.clone();
                    let token = proxy_token.clone();
                    relays.spawn(async move {
                        let _ = proxy(socket, prepared, target, destination, token).await;
                    });
                }
                _ = relays.join_next(), if !relays.is_empty() => {}
            }
        }
    });
    Ok((port, token, Some(Tunnel(task))))
}
async fn proxy_handshake(socket: &mut TcpStream, token: &str) -> Result<()> {
    let mut hello = [0; 2];
    socket.read_exact(&mut hello).await?;
    if hello[0] != 5 || hello[1] == 0 {
        bail!("DB_TUNNEL");
    }
    let mut methods = vec![0; hello[1] as usize];
    socket.read_exact(&mut methods).await?;
    if !methods.contains(&2) {
        socket.write_all(&[5, 255]).await?;
        bail!("DB_TUNNEL");
    }
    socket.write_all(&[5, 2]).await?;
    let mut auth = [0; 2];
    socket.read_exact(&mut auth).await?;
    let mut username = vec![0; auth[1] as usize];
    socket.read_exact(&mut username).await?;
    let mut password = vec![0; socket.read_u8().await? as usize];
    socket.read_exact(&mut password).await?;
    let authenticated = auth[0] == 1
        && username == b"uterm"
        && password.len() == token.len()
        && password
            .iter()
            .zip(token.as_bytes())
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0;
    socket.write_all(&[1, u8::from(!authenticated)]).await?;
    if !authenticated {
        bail!("DB_TUNNEL");
    }
    let mut header = [0; 4];
    socket.read_exact(&mut header).await?;
    if header[0..3] != [5, 1, 0] {
        bail!("DB_TUNNEL");
    }
    let size = match header[3] {
        1 => 4,
        4 => 16,
        3 => socket.read_u8().await? as usize,
        _ => bail!("DB_TUNNEL"),
    };
    let mut address = vec![0; size + 2];
    socket.read_exact(&mut address).await?;
    Ok(())
}
async fn proxy(
    mut socket: TcpStream,
    prepared: crate::ssh_auth::Prepared,
    target: utermd_local::ssh::SshTarget,
    destination: String,
    token: String,
) -> Result<()> {
    tokio::time::timeout(
        Duration::from_secs(12),
        proxy_handshake(&mut socket, &token),
    )
    .await??;
    // This loopback proxy always forwards to the configured endpoint, never the caller's target. 回环代理始终转发到配置的端点，不使用调用方指定的目标。
    let mut command = crate::ssh::base_command()?;
    command.args(target.options());
    prepared.apply(&mut command)?;
    command.args([
        "-T",
        "-S",
        "none",
        "-o",
        "ControlMaster=no",
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
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ForwardX11=no",
        "-o",
        "RemoteCommand=none",
        "-o",
        "ConnectTimeout=12",
        "-o",
        &format!("HostName={}", prepared.effective.hostname),
        "-l",
        &prepared.effective.user,
        "-p",
        &prepared.effective.port,
        "-W",
        &destination,
        "--",
        &target.host,
    ]);
    command.stderr(Stdio::null());
    let mut child = BackgroundChild::spawn(&mut command)?;
    let mut remote = tokio::io::join(
        crate::ssh::pipe_file(child.take_stdout().context("DB_TUNNEL")?),
        crate::ssh::pipe_file(child.take_stdin().context("DB_TUNNEL")?),
    );
    socket.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await?;
    tokio::io::copy_bidirectional(&mut socket, &mut remote).await?;
    Ok(())
}

#[tauri::command]
pub async fn database_connect(
    app: tauri::AppHandle,
    config: Config,
    password: Option<String>,
) -> Result<Value, String> {
    config.validate().map_err(|_| "DB_INVALID_CONFIG")?;
    if password.as_ref().is_some_and(|value| value.len() > 2048) {
        return Err("DB_CREDENTIAL_SIZE".into());
    }
    let state = app.state::<DatabaseState>();
    let _opening = state.reserve().map_err(|error| error.to_string())?;
    let result = async {
        if app.state::<crate::database_components::Components>().0.load(Ordering::SeqCst) { bail!("DB_BUSY"); }
        if state.connections.lock().map_err(|_| anyhow::anyhow!("DB_OPERATION_FAILED"))?.len() >= 8 { bail!("DB_CONNECTION_LIMIT"); }
        let identity = config.identity().await?;
        let password = if let Some(password) = password { password } else if let Some(reference) = &config.credential_id {
            let service = format!("{}.database", app.config().identifier);
            let reference = reference.clone();
            let bytes = tokio::task::spawn_blocking(move || crate::redis_credentials::access(&service, &reference, None)).await?.map_err(|_| anyhow::anyhow!("DB_CREDENTIAL_FAILED"))?.context("DB_CREDENTIAL_MISSING")?;
            let saved: Value = serde_json::from_slice(&bytes)?;
            if saved["target"].as_str() != Some(&identity) { bail!("DB_CREDENTIAL_TARGET_CHANGED"); }
            saved["password"].as_str().context("DB_CREDENTIAL_MISSING")?.to_owned()
        } else { String::new() };
        let handle = app.clone();
        let kind = config.kind.clone();
        let (java, classpath) = tokio::task::spawn_blocking(move || -> Result<_> {
            let java = crate::database_components::java(&handle)?;
            let engine = crate::database_components::bundled_engine(&handle)?;
            let driver = crate::database_components::checked_file(&handle, &kind)?;
            Ok((java, std::env::join_paths([engine, driver])?))
        }).await??;
        let (proxy_port, proxy_token, tunnel) = socks(&app, &config).await?;
        let temporary = tempfile::Builder::new().prefix("uterm-database-").tempdir()?;
        let mut command = Command::new(java);
        // SIGKILL skips Java's deleteOnExit, so the parent owns each worker's temporary files. SIGKILL 不执行 Java 的 deleteOnExit，因此由父进程清理每个连接的临时文件。
        command.arg(format!("-Djava.io.tmpdir={}", temporary.path().display()));
        command.args(["-Xmx192m", "-Djava.awt.headless=true", "-cp"]).arg(classpath).arg("DatabaseBridge")
            .env_remove("JAVA_TOOL_OPTIONS").env_remove("JDK_JAVA_OPTIONS").env_remove("_JAVA_OPTIONS")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = BackgroundChild::spawn(&mut command).context("DB_JAVA")?;
        let input = crate::ssh::pipe_file(child.take_stdin().context("DB_PROTOCOL")?);
        let output = crate::ssh::pipe_file(child.take_stdout().context("DB_PROTOCOL")?);
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let connection = Arc::new(Connection { browser: Mutex::new(None), browser_lock: AsyncMutex::new(()), browser_config: Some((config.clone(), password.clone(), identity.clone())), child: Mutex::new(Some(child)), input: AsyncMutex::new(input), pending: pending.clone(), sequence: AtomicU64::new(1), busy: AtomicBool::new(false), writable: AtomicBool::new(false), transaction: AtomicBool::new(false), dead: AtomicBool::new(false), tunnel: Mutex::new(tunnel), reader: Mutex::new(None), temporary: Mutex::new(Some(temporary)) });
        let weak = Arc::downgrade(&connection);
        let pending_reader = pending.clone();
        let reader = tokio::spawn(async move {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                let result = (&mut reader).take(8 * 1024 * 1024 + 1).read_until(b'\n', &mut line).await;
                if !matches!(result, Ok(count) if count > 0 && count <= 8 * 1024 * 1024 && line.last() == Some(&b'\n')) { break; }
                let Ok(mut value) = serde_json::from_slice::<Value>(&line) else { break; };
                let Some(id) = value["id"].as_u64() else { break; };
                if let Ok(mut items) = pending_reader.lock() {
                    if let Some(sender) = items.remove(&id) {
                        let result = if let Some(error) = value["error"].as_str() { Err(error.to_owned()) } else { Ok(value["result"].take()) };
                        let _ = sender.send(result);
                    }
                }
            }
            if let Some(connection) = weak.upgrade() { connection.stop(); }
        });
        *connection.reader.lock().map_err(|_| anyhow::anyhow!("DB_OPERATION_FAILED"))? = Some(reader);
        if config.identity().await? != identity { bail!("DB_CREDENTIAL_TARGET_CHANGED"); }
        let info = connection.send(json!({"op":"connect","config":config,"password":password,"proxy_port":proxy_port,"proxy_token":proxy_token})).await.map_err(anyhow::Error::msg)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut connections = state.connections.lock().map_err(|_| anyhow::anyhow!("DB_OPERATION_FAILED"))?;
        if connections.len() >= 8 { bail!("DB_CONNECTION_LIMIT"); }
        connections.insert(id.clone(), connection);
        Ok(json!({"handle":id,"info":info}))
    }.await;
    result.map_err(|error: anyhow::Error| error.to_string())
}

fn browse_request(kind: &str, value: &Value) -> Result<Value, String> {
    let view = value["view"].as_str().ok_or("DB_INVALID_REQUEST")?;
    let name = |key: &str| -> Result<&str, String> {
        let text = value[key].as_str().unwrap_or("");
        if text.len() > 1024 || text.contains('\0') {
            return Err("DB_INVALID_REQUEST".into());
        }
        Ok(text)
    };
    let catalog = name("catalog")?;
    let schema = name("schema")?;
    let table = name("table")?;
    if ["catalogs", "tables", "columns"].contains(&view) {
        return Ok(
            json!({"op":"metadata", "view":view, "catalog":catalog, "schema":schema, "table":table}),
        );
    }
    if view != "data" || table.is_empty() {
        return Err("DB_INVALID_REQUEST".into());
    }
    let offset = value
        .get("offset")
        .map_or(Some(0), Value::as_u64)
        .filter(|offset| *offset <= 10000)
        .ok_or("DB_INPUT_LIMIT")?;
    let quote = if kind == "mysql" { "`" } else { "\"" };
    let quoted = |name: &str| format!("{quote}{}{quote}", name.replace(quote, &quote.repeat(2)));
    let namespace = if kind == "mysql" { catalog } else { schema };
    let target = if namespace.is_empty() {
        quoted(table)
    } else {
        format!("{}.{}", quoted(namespace), quoted(table))
    };
    Ok(json!({"op":"query", "sql":format!("SELECT * FROM {target}"), "offset":offset}))
}

#[tauri::command]
pub async fn database_request(
    app: tauri::AppHandle,
    handle: String,
    request: Value,
) -> Result<Value, String> {
    let connection = app
        .state::<DatabaseState>()
        .connections
        .lock()
        .map_err(|_| "DB_OPERATION_FAILED")?
        .get(&handle)
        .cloned()
        .ok_or("DB_DISCONNECTED")?;
    let op = request["op"]
        .as_str()
        .ok_or("DB_INVALID_REQUEST")?
        .to_owned();
    let op = op.as_str();
    if op == "browse" {
        let (config, password, identity) = connection
            .browser_config
            .as_ref()
            .ok_or("DB_INVALID_REQUEST")?;
        let request = browse_request(&config.kind, &request)?;
        let _lock = connection.browser_lock.lock().await;
        if connection.dead.load(Ordering::SeqCst) {
            return Err("DB_DISCONNECTED".into());
        }
        let existing = connection
            .browser
            .lock()
            .map_err(|_| "DB_OPERATION_FAILED")?
            .clone()
            .filter(|(_, browser)| !browser.dead.load(Ordering::SeqCst));
        let (id, browser) = if let Some(browser) = existing {
            browser
        } else {
            if config
                .identity()
                .await
                .map_err(|_| "DB_CREDENTIAL_FAILED")?
                != *identity
            {
                return Err("DB_CREDENTIAL_TARGET_CHANGED".into());
            }
            let opened = database_connect(app.clone(), config.clone(), Some(password.clone()))
                .await
                .map_err(|error| {
                    if error == "DB_DISCONNECTED" || error == "DB_TIMEOUT" {
                        "DB_BROWSE_DISCONNECTED".to_owned()
                    } else {
                        error
                    }
                })?;
            let id = opened["handle"].as_str().ok_or("DB_PROTOCOL")?.to_owned();
            let browser = app
                .state::<DatabaseState>()
                .connections
                .lock()
                .map_err(|_| "DB_OPERATION_FAILED")?
                .get(&id)
                .cloned()
                .ok_or("DB_DISCONNECTED")?;
            let mut slot = connection
                .browser
                .lock()
                .map_err(|_| "DB_OPERATION_FAILED")?;
            if connection.dead.load(Ordering::SeqCst) {
                browser.stop();
                drop(slot);
                app.state::<DatabaseState>()
                    .connections
                    .lock()
                    .map_err(|_| "DB_OPERATION_FAILED")?
                    .remove(&id);
                return Err("DB_DISCONNECTED".into());
            }
            *slot = Some((id.clone(), browser.clone()));
            (id, browser)
        };
        let result = browser.send(request).await;
        if browser.dead.load(Ordering::SeqCst) {
            app.state::<DatabaseState>()
                .connections
                .lock()
                .map_err(|_| "DB_OPERATION_FAILED")?
                .remove(&id);
            connection
                .browser
                .lock()
                .map_err(|_| "DB_OPERATION_FAILED")?
                .take();
            return Err("DB_BROWSE_DISCONNECTED".into());
        }
        return result;
    }
    if !["query", "metadata", "writable", "commit", "rollback"].contains(&op) {
        return Err("DB_INVALID_REQUEST".into());
    }
    if connection.transaction.load(Ordering::SeqCst) && ["metadata", "writable"].contains(&op) {
        return Err("DB_PENDING".into());
    }
    if op == "query" && connection.writable.load(Ordering::SeqCst) {
        connection.transaction.store(true, Ordering::SeqCst);
    }
    let result = connection.send(request).await;
    if let Ok(value) = &result {
        if op == "writable" {
            connection
                .writable
                .store(value["writable"] == true, Ordering::SeqCst);
        }
        if ["commit", "rollback"].contains(&op) {
            connection.transaction.store(false, Ordering::SeqCst);
        }
    }
    result
}

#[tauri::command]
pub async fn database_disconnect(
    app: tauri::AppHandle,
    handle: String,
    discard: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let state = app.state::<DatabaseState>();
        let mut connections = state
            .connections
            .lock()
            .map_err(|_| "DB_OPERATION_FAILED")?;
        if let Some(connection) = connections.get(&handle) {
            if connection.transaction.load(Ordering::SeqCst) && !discard {
                return Err("DB_PENDING".into());
            }
        }
        if let Some(connection) = connections.remove(&handle) {
            if let Some((id, _)) = connection
                .browser
                .lock()
                .map_err(|_| "DB_OPERATION_FAILED")?
                .as_ref()
            {
                connections.remove(id);
            }
            connection.stop();
        }
        Ok(())
    })
    .await
    .map_err(|_| "DB_OPERATION_FAILED".to_owned())?
}
#[tauri::command]
pub fn database_guard(app: tauri::AppHandle, id: String, dirty: bool) -> Result<(), String> {
    let state = app.state::<DatabaseState>();
    let mut drafts = state.drafts.lock().map_err(|_| "DB_OPERATION_FAILED")?;
    if dirty {
        drafts.insert(id);
    } else {
        drafts.remove(&id);
    }
    Ok(())
}
#[tauri::command]
pub fn database_exit(app: tauri::AppHandle) -> Result<(), String> {
    if app.state::<DatabaseState>().busy()
        || app
            .state::<crate::database_components::Components>()
            .0
            .load(Ordering::SeqCst)
    {
        return Err("DB_BUSY".into());
    }
    app.state::<DatabaseState>()
        .drafts
        .lock()
        .map_err(|_| "DB_OPERATION_FAILED")?
        .clear();
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn database_export_sql(
    window: tauri::WebviewWindow,
    sql: String,
) -> Result<bool, String> {
    use std::io::Write;
    use tauri_plugin_dialog::DialogExt;
    if sql.len() > 1048576 {
        return Err("DB_INPUT_LIMIT".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<bool> {
        let selected = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name("query.sql")
            .add_filter("SQL", &["sql"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(false);
        };
        let path = selected
            .into_path()
            .map_err(|_| anyhow::anyhow!("DB_OPERATION_FAILED"))?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(path.parent().context("DB_OPERATION_FAILED")?)?;
        temporary.write_all(sql.as_bytes())?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(path)
            .map_err(|_| anyhow::anyhow!("DB_OPERATION_FAILED"))?;
        Ok(true)
    })
    .await
    .map_err(|_| "DB_OPERATION_FAILED")?
    .map_err(|_| "DB_OPERATION_FAILED".into())
}
#[tauri::command]
pub async fn database_credential(
    app: tauri::AppHandle,
    config: Config,
    password: Option<String>,
    remove: bool,
) -> Result<Option<String>, String> {
    config.validate().map_err(|_| "DB_INVALID_CONFIG")?;
    if !remove && password.is_none() {
        let reference = config
            .credential_id
            .clone()
            .ok_or("DB_CREDENTIAL_MISSING")?;
        let service = format!("{}.database", app.config().identifier);
        let key = reference.clone();
        let bytes = tokio::task::spawn_blocking(move || {
            crate::redis_credentials::access(&service, &key, None)
        })
        .await
        .map_err(|_| "DB_CREDENTIAL_FAILED")?
        .map_err(|_| "DB_CREDENTIAL_FAILED")?
        .ok_or("DB_CREDENTIAL_MISSING")?;
        let credential: Value =
            serde_json::from_slice(&bytes).map_err(|_| "DB_CREDENTIAL_FAILED")?;
        if credential["target"].as_str()
            != Some(
                &config
                    .identity()
                    .await
                    .map_err(|_| "DB_CREDENTIAL_FAILED")?,
            )
        {
            return Err("DB_CREDENTIAL_TARGET_CHANGED".into());
        }
        return Ok(Some(reference));
    }
    let reference = if remove {
        config
            .credential_id
            .clone()
            .ok_or("DB_CREDENTIAL_MISSING")?
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    let bytes = if remove {
        None
    } else {
        let password = password.ok_or("DB_CREDENTIAL_MISSING")?;
        if password.len() > 2048 {
            return Err("DB_CREDENTIAL_SIZE".into());
        }
        let target = config
            .identity()
            .await
            .map_err(|_| "DB_CREDENTIAL_FAILED")?;
        Some(
            serde_json::to_vec(&json!({"target":target,"password":password}))
                .map_err(|_| "DB_CREDENTIAL_FAILED")?,
        )
    };
    let service = format!("{}.database", app.config().identifier);
    let id = reference.clone();
    tokio::task::spawn_blocking(move || {
        crate::redis_credentials::access(&service, &id, Some(bytes))
    })
    .await
    .map_err(|_| "DB_CREDENTIAL_FAILED")?
    .map_err(|_| "DB_CREDENTIAL_FAILED")?;
    Ok(if remove { None } else { Some(reference) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browsing_only_generates_quoted_read_only_requests() {
        let value = json!({"op":"browse", "view":"data", "catalog":"db`name", "schema":"public", "table":"a`b\"; DROP TABLE x", "offset":200, "sql":"DELETE FROM users"});
        assert_eq!(
            browse_request("mysql", &value).unwrap()["sql"],
            "SELECT * FROM `db``name`.`a``b\"; DROP TABLE x`"
        );
        assert_eq!(
            browse_request("postgresql", &value).unwrap()["sql"],
            "SELECT * FROM \"public\".\"a`b\"\"; DROP TABLE x\""
        );
        assert_eq!(browse_request("oracle", &value).unwrap()["offset"], 200);
        assert!(browse_request("mysql", &json!({"view":"writable", "enabled":true})).is_err());
        assert!(
            browse_request("mysql", &json!({"view":"data", "table":"x", "offset":-1})).is_err()
        );
        assert!(browse_request(
            "mysql",
            &json!({"view":"data", "table":"x", "offset":10001})
        )
        .is_err());
        assert!(browse_request("mysql", &json!({"view":"data", "table":"x\0"})).is_err());
        assert_eq!(
            browse_request(
                "mysql",
                &json!({"view":"columns", "table":"x_%", "op":"rollback"})
            )
            .unwrap()["op"],
            "metadata"
        );
    }
    #[test]
    fn stopping_an_owner_closes_browsing_and_reclaims_dead_slots() {
        let owner = Arc::new(fixture());
        let browser = Arc::new(fixture());
        owner.transaction.store(true, Ordering::SeqCst);
        *owner.browser.lock().unwrap() = Some(("browser".into(), browser.clone()));
        owner.stop();
        assert!(browser.dead.load(Ordering::SeqCst));
        let state = DatabaseState::default();
        state
            .connections
            .lock()
            .unwrap()
            .insert("owner".into(), owner);
        state
            .connections
            .lock()
            .unwrap()
            .insert("browser".into(), browser);
        let _slot = state.reserve().unwrap();
        assert!(state.connections.lock().unwrap().is_empty());
    }
    fn fixture() -> Connection {
        Connection {
            browser: Mutex::new(None),
            browser_lock: AsyncMutex::new(()),
            browser_config: None,
            child: Mutex::new(None),
            input: AsyncMutex::new(tokio::fs::File::from_std(tempfile::tempfile().unwrap())),
            pending: Arc::new(Mutex::new(HashMap::new())),
            sequence: AtomicU64::new(1),
            busy: AtomicBool::new(false),
            writable: AtomicBool::new(false),
            transaction: AtomicBool::new(false),
            dead: AtomicBool::new(false),
            tunnel: Mutex::new(None),
            reader: Mutex::new(None),
            temporary: Mutex::new(None),
        }
    }

    #[test]
    fn connection_limit_counts_open_handles_and_handshakes_together() {
        let state = DatabaseState::default();
        let mut slots = Vec::new();
        for _ in 0..8 {
            slots.push(state.reserve().unwrap());
        }
        assert!(state.busy());
        assert!(state.connections.try_lock().is_ok());
        assert!(state.reserve().is_err());
        slots.pop();
        state
            .connections
            .lock()
            .unwrap()
            .insert("one".into(), Arc::new(fixture()));
        assert!(state.reserve().is_err());
        drop(slots);
        assert!(!state.busy());
        assert!(state.reserve().is_ok());
        assert_eq!(state.opening.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn disconnect_aborts_relays_drains_requests_and_removes_worker_files() {
        let connection = fixture();
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().to_owned();
        std::fs::write(path.join("trust.p12"), b"fixture").unwrap();
        *connection.temporary.lock().unwrap() = Some(temporary);
        let task = tokio::spawn(std::future::pending::<()>());
        let abort = task.abort_handle();
        *connection.tunnel.lock().unwrap() = Some(Tunnel(task));
        let (sender, receiver) = oneshot::channel();
        connection.pending.lock().unwrap().insert(1, sender);
        connection.stop();
        tokio::task::yield_now().await;
        assert!(abort.is_finished());
        assert!(!path.exists());
        assert_eq!(receiver.await.unwrap(), Err("DB_DISCONNECTED".into()));
        assert!(connection.dead.load(Ordering::SeqCst));
        assert!(connection.send(json!({"op":"query"})).await.is_err());
    }

    #[tokio::test]
    async fn oversized_requests_release_the_busy_guard_without_writing() {
        let connection = fixture();
        let result = connection
            .send(json!({"op":"query", "sql":"x".repeat(1048576)}))
            .await;
        assert_eq!(result, Err("DB_INPUT_LIMIT".into()));
        assert!(!connection.busy.load(Ordering::SeqCst));
        assert!(connection.pending.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn tunnel_requires_its_private_token() {
        for password in [None, Some("wrong"), Some("private-token")] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                proxy_handshake(&mut socket, "private-token").await.is_ok()
            });
            let mut client = TcpStream::connect(address).await.unwrap();
            client
                .write_all(&[5, 1, if password.is_some() { 2 } else { 0 }])
                .await
                .unwrap();
            let mut reply = [0; 2];
            client.read_exact(&mut reply).await.unwrap();
            if let Some(password) = password {
                assert_eq!(reply, [5, 2]);
                let mut auth = vec![1, 5];
                auth.extend_from_slice(b"uterm");
                auth.push(password.len() as u8);
                auth.extend_from_slice(password.as_bytes());
                client.write_all(&auth).await.unwrap();
                client.read_exact(&mut reply).await.unwrap();
                assert_eq!(reply, [1, u8::from(password != "private-token")]);
                if password == "private-token" {
                    client
                        .write_all(&[5, 1, 0, 1, 127, 0, 0, 1, 12, 234])
                        .await
                        .unwrap();
                }
            } else {
                assert_eq!(reply, [5, 255]);
            }
            assert_eq!(server.await.unwrap(), password == Some("private-token"));
        }
    }
    #[test]
    fn profiles_reject_urls_and_secret_fields() {
        let value = json!({"id":"11111111-1111-4111-8111-111111111111","name":"QA","kind":"mysql","host":"127.0.0.1","port":3306,"database":"test","username":"root","tls":false,"ca_file":"","credential_id":null});
        assert!(serde_json::from_value::<Config>(value.clone())
            .unwrap()
            .validate()
            .is_ok());
        let mut secret = value.clone();
        secret["password"] = "secret".into();
        assert!(serde_json::from_value::<Config>(secret).is_err());
        for field in ["host", "database"] {
            let mut url = value.clone();
            url[field] = "host?allowLoadLocalInfile=true".into();
            assert!(serde_json::from_value::<Config>(url)
                .unwrap()
                .validate()
                .is_err());
        }
    }
}
