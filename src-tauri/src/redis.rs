use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use redis::{aio::MultiplexedConnection, Cmd, RedisConnectionInfo, Value};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    task::{Context as TaskContext, Poll},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf},
    net::TcpStream,
    sync::Mutex as AsyncMutex,
};
use tokio_rustls::{
    rustls::{
        self,
        pki_types::{pem::PemObject, CertificateDer, ServerName},
    },
    TlsConnector,
};
use utermd_local::BackgroundChild;

const PREVIEW: usize = 1024 * 1024;
const LIST_EDIT_MEMBERS: usize = 10000;
const WIRE_LIMIT: usize = 16 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(12);
const MAX_CONNECTIONS: usize = 8;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub db: u16,
    pub username: String,
    pub tls: bool,
    pub ca_file: String,
    pub server_name: String,
    pub ssh_host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_target: Option<utermd_local::ssh::SshTarget>,
    pub credential_id: Option<String>,
}
impl Config {
    fn validate(&self) -> Result<()> {
        uuid::Uuid::parse_str(&self.id).context("REDIS_INVALID_CONFIG")?;
        if self.name.trim().is_empty()
            || self.name.len() > 800
            || self.port == 0
            || self.db > 1024
            || !valid_host(&self.host)
            || (!self.server_name.is_empty() && !valid_host(&self.server_name))
            || self.username.len() > 512
            || self.ca_file.len() > 4096
            || self.ca_file.contains('\0')
        {
            bail!("REDIS_INVALID_CONFIG");
        }
        if !self.ssh_host.is_empty() {
            utermd_local::ssh::validate_host(&self.ssh_host)?;
        }
        if let Some(target) = &self.ssh_target {
            target.validate()?;
            if target.host != self.ssh_host {
                bail!("REDIS_INVALID_CONFIG");
            }
        }
        if let Some(reference) = &self.credential_id {
            crate::redis_credentials::validate_reference(reference)?;
        }
        Ok(())
    }
    async fn target(&self) -> Result<String> {
        self.validate()?;
        let ssh = if self.ssh_host.is_empty() {
            String::new()
        } else if let Some(target) = &self.ssh_target {
            crate::ssh::effective_target(target).await?.identity
        } else {
            crate::ssh::effective_identity(&self.ssh_host)
                .await?
                .identity
        };
        self.target_with_ssh(&ssh).await
    }
    async fn target_with_ssh(&self, ssh: &str) -> Result<String> {
        let ca = if self.tls && !self.ca_file.is_empty() {
            digest(&read_ca(&self.ca_file).await?)
        } else {
            String::new()
        };
        Ok(digest(
            serde_json::to_string(&(
                self.host.to_lowercase(),
                self.port,
                &self.username,
                self.tls,
                &self.server_name,
                ca,
                &self.ssh_host,
                ssh,
            ))?
            .as_bytes(),
        ))
    }
}
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 255
        && !host.starts_with('-')
        && host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-:".contains(&c))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn fail(error: impl std::fmt::Display) -> String {
    error.to_string()
}
trait Io: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}
struct LimitedStream {
    stream: Box<dyn Io>,
    budget: Arc<AtomicUsize>,
}
impl AsyncRead for LimitedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let remaining = self.budget.load(Ordering::Relaxed);
        if remaining == 0 {
            return Poll::Ready(Err(std::io::Error::other("REDIS_REPLY_LIMIT")));
        }
        let mut short = buf.take(remaining.min(buf.remaining()));
        match Pin::new(&mut self.stream).poll_read(cx, &mut short) {
            Poll::Ready(Ok(())) => {
                let count = short.filled().len();
                self.budget.fetch_sub(count, Ordering::Relaxed);
                // The bounded ReadBuf initialized exactly its filled prefix in the shared buffer. 子 ReadBuf 已初始化共享缓冲区中实际填充的前缀。
                unsafe {
                    buf.assume_init(count);
                }
                buf.advance(count);
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}
impl AsyncWrite for LimitedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
async fn read_ca(path: &str) -> Result<Vec<u8>> {
    let file = tokio::fs::File::open(path)
        .await
        .context("REDIS_CA_FAILED")?;
    let mut bytes = Vec::new();
    file.take(PREVIEW as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > PREVIEW {
        bail!("REDIS_CA_FAILED");
    }
    Ok(bytes)
}
async fn transport(
    config: &Config,
    expected: &str,
    prepared: Option<crate::ssh_auth::Prepared>,
) -> Result<(Box<dyn Io>, Option<BackgroundChild>)> {
    let (mut stream, child): (Box<dyn Io>, _) = if config.ssh_host.is_empty() {
        if config.target_with_ssh("").await? != expected {
            bail!("REDIS_CREDENTIAL_TARGET_CHANGED");
        }
        let socket = TcpStream::connect((config.host.as_str(), config.port))
            .await
            .context("REDIS_CONNECT_FAILED")?;
        socket.set_nodelay(true)?;
        (Box::new(socket), None)
    } else {
        let endpoint = if let Some(prepared) = &prepared {
            prepared.effective.clone()
        } else if config.ssh_target.is_some() {
            bail!("SSH_PASSWORD_REQUIRED");
        } else {
            crate::ssh::effective_identity(&config.ssh_host).await?
        };
        let interactive = prepared
            .as_ref()
            .is_some_and(|value| value.askpass.is_some());
        if config.target_with_ssh(&endpoint.identity).await? != expected {
            bail!("REDIS_CREDENTIAL_TARGET_CHANGED");
        }
        let destination = if config.host.contains(':') {
            format!("[{}]:{}", config.host, config.port)
        } else {
            format!("{}:{}", config.host, config.port)
        };
        let mut command = crate::ssh::base_command()?;
        if let Some(target) = &config.ssh_target {
            command.args(target.options());
        }
        if let Some(prepared) = &prepared {
            prepared.apply(&mut command)?;
        }
        command.args([
            "-T",
            "-S",
            "none",
            "-o",
            "ControlMaster=no",
            "-o",
            if interactive {
                "BatchMode=no"
            } else {
                "BatchMode=yes"
            },
            "-o",
            if interactive {
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
            "ServerAliveInterval=30",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            &format!("HostName={}", endpoint.hostname),
            "-l",
            &endpoint.user,
            "-p",
            &endpoint.port,
            "-W",
            &destination,
            "--",
            &config.ssh_host,
        ]);
        let mut child = BackgroundChild::spawn(&mut command)?;
        let stream = tokio::io::join(
            crate::ssh::pipe_file(child.take_stdout().context("SSH_PIPE_FAILED")?),
            crate::ssh::pipe_file(child.take_stdin().context("SSH_PIPE_FAILED")?),
        );
        let mut errors = crate::ssh::pipe_file(child.take_stderr().context("SSH_PIPE_FAILED")?);
        // Drain diagnostics without exposing credential-bearing server output. 排空诊断流，不暴露可能含凭据的服务端输出。
        tokio::spawn(async move {
            let mut buf = [0; 4096];
            while let Ok(count) = errors.read(&mut buf).await {
                if count == 0 {
                    break;
                }
            }
        });
        (Box::new(stream), Some(child))
    };
    if config.tls {
        let mut roots = rustls::RootCertStore::empty();
        for cert in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(cert);
        }
        if !config.ca_file.is_empty() {
            let bytes = read_ca(&config.ca_file).await?;
            let certs: Vec<_> = CertificateDer::pem_slice_iter(&bytes)
                .collect::<std::result::Result<_, _>>()
                .context("REDIS_CA_FAILED")?;
            if certs.is_empty() {
                bail!("REDIS_CA_FAILED");
            }
            for cert in certs {
                roots.add(cert).context("REDIS_CA_FAILED")?;
            }
        }
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let name = if config.server_name.is_empty() {
            &config.host
        } else {
            &config.server_name
        };
        let name = ServerName::try_from(name.to_owned()).context("REDIS_TLS_FAILED")?;
        stream = Box::new(
            TlsConnector::from(Arc::new(tls))
                .connect(name, stream)
                .await
                .context("REDIS_TLS_FAILED")?,
        );
    }
    Ok((stream, child))
}
struct Connection {
    config: Config,
    password: Option<String>,
    target: String,
    wire: AsyncMutex<MultiplexedConnection>,
    driver: tokio::task::JoinHandle<()>,
    child: Mutex<Option<BackgroundChild>>,
    budget: Arc<AtomicUsize>,
    writable: AtomicBool,
    dead: AtomicBool,
    db: AtomicUsize,
    mutations: AtomicUsize,
}
impl Connection {
    fn stop(&self) {
        self.dead.store(true, Ordering::Release);
        self.driver.abort();
        if let Ok(mut child) = self.child.lock() {
            child.take();
        }
    }
    async fn open(
        config: Config,
        password: Option<String>,
        expected_target: Option<String>,
        prepared: Option<crate::ssh_auth::Prepared>,
    ) -> Result<Self> {
        config.validate()?;
        let target = if let Some(target) = expected_target {
            target
        } else {
            config.target().await?
        };
        let handshake_timeout = if prepared
            .as_ref()
            .is_some_and(|value| value.askpass.is_some())
        {
            Duration::from_secs(120)
        } else {
            TIMEOUT
        };
        let (stream, child) =
            tokio::time::timeout(handshake_timeout, transport(&config, &target, prepared))
                .await
                .context("REDIS_CONNECT_TIMEOUT")??;
        let budget = Arc::new(AtomicUsize::new(WIRE_LIMIT));
        let info = RedisConnectionInfo::default()
            .set_db(config.db.into())
            .set_skip_set_lib_name();
        let info = if config.username.is_empty() {
            info
        } else {
            info.set_username(&config.username)
        };
        let info = if let Some(password) = &password {
            info.set_password(password)
        } else {
            info
        };
        let (wire, driver) = tokio::time::timeout(
            handshake_timeout,
            MultiplexedConnection::new_with_config(
                &info,
                LimitedStream {
                    stream,
                    budget: budget.clone(),
                },
                redis::AsyncConnectionConfig::new()
                    .set_response_timeout(Some(handshake_timeout))
                    .set_concurrency_limit(1),
            ),
        )
        .await
        .context("REDIS_CONNECT_TIMEOUT")?
        .context("REDIS_AUTH_FAILED")?;
        let mut wire = wire;
        wire.set_response_timeout(TIMEOUT);
        let db = config.db as usize;
        Ok(Self {
            config,
            password,
            target,
            wire: AsyncMutex::new(wire),
            driver: tokio::spawn(driver),
            child: Mutex::new(child),
            budget,
            writable: AtomicBool::new(false),
            dead: AtomicBool::new(false),
            db: AtomicUsize::new(db),
            mutations: AtomicUsize::new(0),
        })
    }
    async fn query(
        &self,
        wire: &mut MultiplexedConnection,
        command: &Cmd,
        write: bool,
    ) -> Result<Value> {
        if self.dead.load(Ordering::Acquire) {
            bail!("REDIS_RECONNECT");
        }
        self.budget.store(WIRE_LIMIT, Ordering::Relaxed);
        match command.query_async::<Value>(wire).await {
            Ok(value) => Ok(value),
            Err(error) => {
                if error.is_io_error() || error.is_timeout() {
                    self.stop();
                    bail!(if write {
                        "REDIS_WRITE_UNCERTAIN"
                    } else {
                        "REDIS_RECONNECT"
                    });
                }
                if error
                    .code()
                    .is_some_and(|code| code == "MOVED" || code == "ASK")
                {
                    bail!("REDIS_CLUSTER_UNSUPPORTED");
                }
                // Expose a server error category, never arbitrary values or authentication text. 仅显示服务端错误类别，不显示任意值或认证文本。
                Err(anyhow!("REDIS_SERVER: {}", error.code().unwrap_or("ERR")))
            }
        }
    }
    async fn request(&self, request: Request) -> Result<serde_json::Value> {
        let _mutation = if matches!(
            &request,
            Request::Save { .. } | Request::Mutate { .. } | Request::Collection { .. }
        ) {
            self.mutations.fetch_add(1, Ordering::SeqCst);
            Some(MutationGuard(&self.mutations))
        } else {
            None
        };
        // WATCH and transaction state must not interleave with browsing or console commands. WATCH 与事务状态不能和浏览、命令台请求交错。
        let mut wire = self.wire.lock().await;
        match request {
            Request::Scan { cursor, pattern } => {
                if pattern.len() > 1024 {
                    bail!("REDIS_INPUT_LIMIT");
                }
                let value = self
                    .query(
                        &mut wire,
                        redis::cmd("SCAN")
                            .arg(cursor)
                            .arg("MATCH")
                            .arg(pattern)
                            .arg("COUNT")
                            .arg(200),
                        false,
                    )
                    .await?;
                let (next, keys): (String, Vec<Vec<u8>>) = redis::from_redis_value(value)?;
                if keys.len() > 10000 {
                    bail!("REDIS_REPLY_LIMIT");
                }
                let mut seen = HashSet::new();
                let keys: Vec<_> = keys
                    .into_iter()
                    .filter(|key| seen.insert(key.clone()))
                    .collect();
                // Empty SCAN pages have no metadata requests; an empty pipeline has no reply. 空 SCAN 页无需元数据请求，空管道不会收到响应。
                if keys.is_empty() {
                    return Ok(serde_json::json!({"cursor":next,"entries":[]}));
                }
                let mut pipeline = redis::pipe();
                for key in &keys {
                    check_key(key)?;
                    pipeline.cmd("TYPE").arg(key).cmd("PTTL").arg(key);
                }
                self.budget.store(WIRE_LIMIT, Ordering::Relaxed);
                let metadata: Vec<Value> = match pipeline.query_async(&mut *wire).await {
                    Ok(values) => values,
                    Err(_) => {
                        self.stop();
                        bail!("REDIS_SCAN_FAILED");
                    }
                };
                let mut entries = Vec::new();
                for (key, values) in keys.iter().zip(metadata.chunks_exact(2)) {
                    entries.push(serde_json::json!({"key": blob(key,4096), "kind": redis::from_redis_value::<String>(values[0].clone())?, "ttl": redis::from_redis_value::<i64>(values[1].clone())?}));
                }
                Ok(serde_json::json!({"cursor":next,"entries":entries}))
            }
            Request::Read {
                key,
                field,
                cursor,
                offset,
                pattern,
            } => {
                let key = key_bytes(&key)?;
                let kind: String = redis::from_redis_value(
                    self.query(&mut wire, redis::cmd("TYPE").arg(&key), false)
                        .await?,
                )?;
                let ttl: i64 = redis::from_redis_value(
                    self.query(&mut wire, redis::cmd("PTTL").arg(&key), false)
                        .await?,
                )?;
                if offset > i64::MAX as usize - PREVIEW {
                    bail!("REDIS_INPUT_LIMIT");
                }
                let mut result =
                    serde_json::json!({"kind":kind,"ttl":ttl,"db":self.db.load(Ordering::Relaxed)});
                match kind.as_str() {
                    "none" => bail!("REDIS_KEY_MISSING"),
                    "string" => {
                        let size: usize = redis::from_redis_value(
                            self.query(&mut wire, redis::cmd("STRLEN").arg(&key), false)
                                .await?,
                        )?;
                        let bytes: Vec<u8> = redis::from_redis_value(
                            self.query(
                                &mut wire,
                                redis::cmd("GETRANGE")
                                    .arg(&key)
                                    .arg(offset)
                                    .arg(offset + PREVIEW - 1),
                                false,
                            )
                            .await?,
                        )?;
                        result["size"] = size.into();
                        result["value"] = serde_json::to_value(blob(&bytes, PREVIEW))?;
                        result["version"] = if offset == 0 && size <= PREVIEW {
                            digest(&bytes).into()
                        } else {
                            serde_json::Value::Null
                        };
                    }
                    "hash" if field.is_some() => {
                        let field = key_bytes(field.as_deref().unwrap())?;
                        let value = self.current(&mut wire, &key, Some(&field)).await?;
                        result["value"] = value
                            .as_ref()
                            .map(|bytes| blob(bytes, PREVIEW))
                            .map(serde_json::to_value)
                            .transpose()?
                            .unwrap_or(serde_json::Value::Null);
                        result["version"] = value.map(|bytes| digest(&bytes)).into();
                    }
                    "hash" | "set" => {
                        if pattern.len() > 1024 {
                            bail!("REDIS_INPUT_LIMIT");
                        }
                        let value = self
                            .query(
                                &mut wire,
                                redis::cmd(if kind == "hash" { "HSCAN" } else { "SSCAN" })
                                    .arg(&key)
                                    .arg(cursor)
                                    .arg("MATCH")
                                    .arg(pattern)
                                    .arg("COUNT")
                                    .arg(100),
                                false,
                            )
                            .await?;
                        let (next, bytes): (String, Vec<Vec<u8>>) = redis::from_redis_value(value)?;
                        result["cursor"] = next.into();
                        result["items"] = serde_json::to_value(
                            bytes
                                .iter()
                                .take(2000)
                                .map(|bytes| blob(bytes, 64 * 1024))
                                .collect::<Vec<_>>(),
                        )?;
                        result["partial"] = (bytes.len() > 2000).into();
                        result["size"] = redis::from_redis_value::<u64>(
                            self.query(
                                &mut wire,
                                redis::cmd(if kind == "hash" { "HLEN" } else { "SCARD" }).arg(&key),
                                false,
                            )
                            .await?,
                        )?
                        .into();
                    }
                    "list" => {
                        let snapshot = self.list_snapshot(&mut wire, &key).await?;
                        let (size, bytes, version) = if let Some(bytes) = snapshot {
                            let version = list_version(&bytes);
                            let page = bytes
                                .iter()
                                .skip(offset)
                                .take(200)
                                .cloned()
                                .collect::<Vec<_>>();
                            (bytes.len() as u64, page, Some(version))
                        } else {
                            let size = redis::from_redis_value::<u64>(
                                self.query(&mut wire, redis::cmd("LLEN").arg(&key), false)
                                    .await?,
                            )?;
                            let bytes = redis::from_redis_value::<Vec<Vec<u8>>>(
                                self.query(
                                    &mut wire,
                                    redis::cmd("LRANGE").arg(&key).arg(offset).arg(offset + 199),
                                    false,
                                )
                                .await?,
                            )?;
                            (size, bytes, None)
                        };
                        result["items"] = serde_json::to_value(
                            bytes
                                .iter()
                                .map(|bytes| blob(bytes, 64 * 1024))
                                .collect::<Vec<_>>(),
                        )?;
                        result["size"] = size.into();
                        result["version"] = version.into();
                    }
                    "zset" => {
                        let mut command =
                            redis::cmd(if kind == "list" { "LRANGE" } else { "ZRANGE" });
                        command.arg(&key).arg(offset).arg(offset + 199);
                        if kind == "zset" {
                            command.arg("WITHSCORES");
                        }
                        let bytes: Vec<Vec<u8>> =
                            redis::from_redis_value(self.query(&mut wire, &command, false).await?)?;
                        result["items"] = serde_json::to_value(
                            bytes
                                .iter()
                                .map(|bytes| blob(bytes, 64 * 1024))
                                .collect::<Vec<_>>(),
                        )?;
                        result["size"] = redis::from_redis_value::<u64>(
                            self.query(
                                &mut wire,
                                redis::cmd(if kind == "list" { "LLEN" } else { "ZCARD" }).arg(&key),
                                false,
                            )
                            .await?,
                        )?
                        .into();
                    }
                    _ => result["unsupported"] = true.into(),
                }
                Ok(result)
            }
            Request::Save {
                key,
                field,
                value,
                expected,
                db,
            } => {
                self.require_write(db)?;
                let key = key_bytes(&key)?;
                let field = field.as_deref().map(key_bytes).transpose()?;
                let bytes = STANDARD.decode(value)?;
                if bytes.len() > PREVIEW
                    || expected
                        .as_ref()
                        .is_some_and(|v| v.len() != 64 || !v.bytes().all(|b| b.is_ascii_hexdigit()))
                {
                    bail!("REDIS_INPUT_LIMIT");
                }
                self.query(&mut wire, redis::cmd("WATCH").arg(&key), false)
                    .await?;
                let result = async {
                    let original = self.current(&mut wire, &key, field.as_deref()).await?;
                    if original.as_ref().map(|v| digest(v)) != expected {
                        bail!("REDIS_CONFLICT");
                    }
                    let mut command = redis::cmd(if field.is_some() { "HSET" } else { "SET" });
                    command.arg(&key);
                    if let Some(field) = &field {
                        command.arg(field);
                    }
                    command.arg(&bytes);
                    if field.is_none() && original.is_some() {
                        command.arg("KEEPTTL");
                    }
                    self.query(&mut wire, &redis::cmd("MULTI"), false).await?;
                    self.query(&mut wire, &command, false).await?;
                    let executed = self.query(&mut wire, &redis::cmd("EXEC"), true).await?;
                    if executed == Value::Nil {
                        bail!("REDIS_CONFLICT");
                    }
                    if let Value::Array(values) = executed {
                        if values.iter().any(|v| matches!(v, Value::ServerError(_))) {
                            bail!("REDIS_WRITE_FAILED");
                        }
                    }
                    Ok(serde_json::json!({"version":digest(&bytes)}))
                }
                .await;
                if result.is_err() {
                    let _ = self.query(&mut wire, &redis::cmd("DISCARD"), false).await;
                }
                let _ = self.query(&mut wire, &redis::cmd("UNWATCH"), false).await;
                result
            }
            Request::Collection { key, db, change } => {
                self.require_write(db)?;
                let key = key_bytes(&key)?;
                let values = change.validate()?;
                self.query(&mut wire, redis::cmd("WATCH").arg(&key), false)
                    .await?;
                let result = self
                    .collection_change(&mut wire, &key, &change, values)
                    .await;
                if result.is_err() {
                    let _ = self.query(&mut wire, &redis::cmd("DISCARD"), false).await;
                }
                let _ = self.query(&mut wire, &redis::cmd("UNWATCH"), false).await;
                result
            }
            Request::Mutate {
                key,
                action,
                argument,
                db,
            } => {
                self.require_write(db)?;
                let key = key_bytes(&key)?;
                let exists: bool = redis::from_redis_value(
                    self.query(&mut wire, redis::cmd("EXISTS").arg(&key), false)
                        .await?,
                )?;
                if !exists {
                    bail!("REDIS_KEY_MISSING");
                }
                let mut command = match action.as_str() {
                    "delete" => {
                        let mut cmd = redis::cmd("UNLINK");
                        cmd.arg(&key);
                        cmd
                    }
                    "rename" => {
                        let destination = key_bytes(&argument)?;
                        let mut cmd = redis::cmd("RENAMENX");
                        cmd.arg(&key).arg(destination);
                        cmd
                    }
                    "ttl" => {
                        let ttl: u64 = argument.parse()?;
                        if ttl == 0 || ttl > 3_153_600_000 {
                            bail!("REDIS_INVALID_TTL");
                        }
                        let mut cmd = redis::cmd("EXPIRE");
                        cmd.arg(&key).arg(ttl);
                        cmd
                    }
                    "persist" => {
                        let mut cmd = redis::cmd("PERSIST");
                        cmd.arg(&key);
                        cmd
                    }
                    "hdelete" => {
                        let field = key_bytes(&argument)?;
                        let mut cmd = redis::cmd("HDEL");
                        cmd.arg(&key).arg(field);
                        cmd
                    }
                    _ => bail!("REDIS_COMMAND_BLOCKED"),
                };
                let value = self.query(&mut wire, &mut command, true).await?;
                if action == "rename" && redis::from_redis_value::<i64>(value)? == 0 {
                    bail!("REDIS_NAME_EXISTS");
                }
                Ok(serde_json::json!({"ok":true}))
            }
            Request::Select { db } => {
                if db > 1024 {
                    bail!("REDIS_INVALID_CONFIG");
                }
                self.query(&mut wire, redis::cmd("SELECT").arg(db), false)
                    .await?;
                self.db.store(db as usize, Ordering::Relaxed);
                Ok(serde_json::json!({"db":db}))
            }
            Request::Console { args } => {
                let command = console_command(args)?;
                let start = Instant::now();
                let value = self.query(&mut wire, &command, false).await?;
                Ok(
                    serde_json::json!({"result":display_value(value,0),"elapsed":start.elapsed().as_millis()}),
                )
            }
        }
    }
    fn require_write(&self, db: u16) -> Result<()> {
        if !self.writable.load(Ordering::Acquire) {
            bail!("REDIS_READ_ONLY");
        }
        if self.db.load(Ordering::Relaxed) != db as usize {
            bail!("REDIS_DB_CHANGED");
        }
        Ok(())
    }
    async fn list_snapshot(
        &self,
        wire: &mut MultiplexedConnection,
        key: &[u8],
    ) -> Result<Option<Vec<Vec<u8>>>> {
        let size: usize =
            redis::from_redis_value(self.query(wire, redis::cmd("LLEN").arg(key), false).await?)?;
        if size > LIST_EDIT_MEMBERS {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        let mut total = 0;
        // Bound aggregate reads before fetching another page; oversized lists remain browsable. 读取下一页前限制累计体积，超大列表仍可浏览。
        for start in (0..size).step_by(200) {
            let page: Vec<Vec<u8>> = redis::from_redis_value(
                self.query(
                    wire,
                    redis::cmd("LRANGE")
                        .arg(key)
                        .arg(start)
                        .arg((start + 199).min(size - 1)),
                    false,
                )
                .await?,
            )?;
            total += page.iter().map(Vec::len).sum::<usize>();
            if total > PREVIEW {
                return Ok(None);
            }
            bytes.extend(page);
        }
        Ok(Some(bytes))
    }
    async fn collection_change(
        &self,
        wire: &mut MultiplexedConnection,
        key: &[u8],
        change: &CollectionChange,
        (member, value): (Vec<u8>, Vec<u8>),
    ) -> Result<serde_json::Value> {
        let kind: String =
            redis::from_redis_value(self.query(wire, redis::cmd("TYPE").arg(key), false).await?)?;
        let creating = change.action == "create";
        if creating && kind != "none" {
            bail!("REDIS_NAME_EXISTS");
        }
        if !creating && kind != change.kind {
            bail!("REDIS_CONFLICT");
        }
        let mut commands = Vec::new();
        if change.kind == "list" {
            if matches!(change.action.as_str(), "update" | "delete") {
                let snapshot = self
                    .list_snapshot(wire, key)
                    .await?
                    .context("REDIS_LIST_EDIT_LIMIT")?;
                if change.expected.as_deref() != Some(list_version(&snapshot).as_str()) {
                    bail!("REDIS_CONFLICT");
                }
                let index = change.index.context("REDIS_INPUT_LIMIT")?;
                if index >= snapshot.len() {
                    bail!("REDIS_CONFLICT");
                }
                if change.action == "update" {
                    let mut command = redis::cmd("LSET");
                    command.arg(key).arg(index).arg(&value);
                    commands.push(command);
                } else if index == 0 || index + 1 == snapshot.len() {
                    let mut command = redis::cmd(if index == 0 { "LPOP" } else { "RPOP" });
                    command.arg(key);
                    commands.push(command);
                } else {
                    // Trim the prefix and append the bounded tail; duplicate values keep their positions. 保留前缀并追加有界尾部，重复值不会影响删除位置。
                    let mut trim = redis::cmd("LTRIM");
                    trim.arg(key).arg(0).arg(index - 1);
                    commands.push(trim);
                    let mut push = redis::cmd("RPUSH");
                    push.arg(key).arg(&snapshot[index + 1..]);
                    commands.push(push);
                }
            } else {
                let mut command = redis::cmd(if change.position.as_deref() == Some("head") {
                    "LPUSH"
                } else {
                    "RPUSH"
                });
                command.arg(key).arg(&value);
                commands.push(command);
            }
        } else {
            let zset = change.kind == "zset";
            let original = if creating {
                Value::Nil
            } else {
                self.query(
                    wire,
                    redis::cmd(if zset { "ZSCORE" } else { "SISMEMBER" })
                        .arg(key)
                        .arg(&member),
                    false,
                )
                .await?
            };
            if matches!(change.action.as_str(), "update" | "delete") {
                let expected = if zset {
                    if original == Value::Nil {
                        None
                    } else {
                        Some(redis::from_redis_value::<String>(original)?)
                    }
                } else if redis::from_redis_value::<bool>(original)? {
                    Some("present".into())
                } else {
                    None
                };
                if expected.is_none() || expected != change.expected {
                    bail!("REDIS_CONFLICT");
                }
            }
            if change.action != "delete"
                && (change.action != "update" || value != member)
                && !creating
            {
                let exists = self
                    .query(
                        wire,
                        redis::cmd(if zset { "ZSCORE" } else { "SISMEMBER" })
                            .arg(key)
                            .arg(&value),
                        false,
                    )
                    .await?;
                if if zset {
                    exists != Value::Nil
                } else {
                    redis::from_redis_value::<bool>(exists)?
                } {
                    bail!("REDIS_MEMBER_EXISTS");
                }
            }
            if change.action == "delete" || (change.action == "update" && value != member) {
                let mut command = redis::cmd(if zset { "ZREM" } else { "SREM" });
                command.arg(key).arg(&member);
                commands.push(command);
            }
            if change.action != "delete" {
                // Add before removing so replacing the last member preserves the key and its TTL. 先添加再移除，替换最后一个成员时保留 Key 及 TTL。
                let mut command = redis::cmd(if zset { "ZADD" } else { "SADD" });
                command.arg(key);
                if zset {
                    command.arg(change.score.as_deref().unwrap());
                }
                command.arg(&value);
                commands.insert(0, command);
            }
        }
        self.query(wire, &redis::cmd("MULTI"), false).await?;
        for command in &commands {
            self.query(wire, command, false).await?;
        }
        let executed = self.query(wire, &redis::cmd("EXEC"), true).await?;
        match executed {
            Value::Nil => bail!("REDIS_CONFLICT"),
            Value::Array(values) if values.iter().any(|v| matches!(v, Value::ServerError(_))) => {
                self.stop();
                bail!("REDIS_WRITE_UNCERTAIN")
            }
            _ => Ok(serde_json::json!({"ok": true})),
        }
    }
    async fn current(
        &self,
        wire: &mut MultiplexedConnection,
        key: &[u8],
        field: Option<&[u8]>,
    ) -> Result<Option<Vec<u8>>> {
        let kind: String =
            redis::from_redis_value(self.query(wire, redis::cmd("TYPE").arg(key), false).await?)?;
        if kind == "none" {
            return Ok(None);
        }
        if kind != if field.is_some() { "hash" } else { "string" } {
            bail!("REDIS_CONFLICT");
        }
        let mut size = redis::cmd(if field.is_some() { "HSTRLEN" } else { "STRLEN" });
        size.arg(key);
        if let Some(field) = field {
            size.arg(field);
        }
        let count: usize = redis::from_redis_value(self.query(wire, &size, false).await?)?;
        if count > PREVIEW {
            bail!("REDIS_VALUE_LIMIT");
        }
        let mut get = redis::cmd(if field.is_some() { "HGET" } else { "GET" });
        get.arg(key);
        if let Some(field) = field {
            get.arg(field);
        }
        let value = self.query(wire, &get, false).await?;
        if value == Value::Nil {
            return Ok(None);
        }
        let bytes: Vec<u8> = redis::from_redis_value(value)?;
        if bytes.len() > PREVIEW {
            bail!("REDIS_VALUE_LIMIT");
        }
        Ok(Some(bytes))
    }
}
struct MutationGuard<'a>(&'a AtomicUsize);
impl Drop for MutationGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.stop();
    }
}
#[derive(Default)]
pub struct RedisState {
    connections: AsyncMutex<HashMap<String, Arc<Connection>>>,
    dirty: Mutex<HashSet<String>>,
    opening: AtomicUsize,
}
impl RedisState {
    fn reserve(&self, connections: usize) -> Result<MutationGuard<'_>, String> {
        if connections + self.opening.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
            return Err("REDIS_CONNECTION_LIMIT".into());
        }
        self.opening.fetch_add(1, Ordering::SeqCst);
        Ok(MutationGuard(&self.opening))
    }
    pub fn busy(&self) -> bool {
        self.opening.load(Ordering::SeqCst) > 0
            || self.connections.try_lock().map_or(true, |connections| {
                connections
                    .values()
                    .any(|connection| connection.mutations.load(Ordering::SeqCst) > 0)
            })
    }
    pub fn dirty(&self) -> bool {
        self.dirty.lock().map_or(true, |v| !v.is_empty())
    }
    pub fn first_dirty(&self) -> Option<String> {
        self.dirty.lock().ok()?.iter().next().cloned()
    }
    pub fn stop(&self) {
        if let Ok(connections) = self.connections.try_lock() {
            for connection in connections.values() {
                connection.stop();
            }
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Scan {
        cursor: String,
        pattern: String,
    },
    Read {
        key: String,
        field: Option<String>,
        cursor: String,
        offset: usize,
        pattern: String,
    },
    Save {
        key: String,
        field: Option<String>,
        value: String,
        expected: Option<String>,
        db: u16,
    },
    Collection {
        key: String,
        db: u16,
        change: CollectionChange,
    },
    Mutate {
        key: String,
        action: String,
        argument: String,
        db: u16,
    },
    Select {
        db: u16,
    },
    Console {
        args: Vec<String>,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionChange {
    kind: String,
    action: String,
    member: Option<String>,
    value: Option<String>,
    index: Option<usize>,
    score: Option<String>,
    expected: Option<String>,
    position: Option<String>,
}
impl CollectionChange {
    fn validate(&self) -> Result<(Vec<u8>, Vec<u8>)> {
        if !matches!(self.kind.as_str(), "list" | "set" | "zset")
            || !matches!(self.action.as_str(), "create" | "add" | "update" | "delete")
            || self
                .expected
                .as_ref()
                .is_some_and(|value| value.len() > 128)
            || self.index.is_some_and(|index| index >= LIST_EDIT_MEMBERS)
            || self
                .position
                .as_deref()
                .is_some_and(|value| !matches!(value, "head" | "tail"))
        {
            bail!("REDIS_INPUT_LIMIT");
        }
        let editing = matches!(self.action.as_str(), "update" | "delete");
        if editing
            && (self.expected.is_none()
                || (self.kind == "list" && self.index.is_none())
                || (self.kind != "list" && self.member.is_none()))
        {
            bail!("REDIS_INPUT_LIMIT");
        }
        if self.action != "delete" && self.value.is_none() {
            bail!("REDIS_INPUT_LIMIT");
        }
        if self.kind == "zset" && self.action != "delete" {
            if !self.score.as_deref().is_some_and(valid_score) {
                bail!("REDIS_INVALID_SCORE");
            }
        }
        let decode = |value: Option<&str>| -> Result<Vec<u8>> {
            let value = value.unwrap_or("");
            if value.len() > PREVIEW.div_ceil(3) * 4 {
                bail!("REDIS_VALUE_LIMIT");
            }
            let bytes = STANDARD.decode(value).context("REDIS_INPUT_LIMIT")?;
            if bytes.len() > PREVIEW {
                bail!("REDIS_VALUE_LIMIT");
            }
            Ok(bytes)
        };
        Ok((
            decode(self.member.as_deref())?,
            decode(self.value.as_deref())?,
        ))
    }
}
fn valid_score(value: &str) -> bool {
    // Reject underflow before queuing a member replacement. 拒绝下溢分数，避免成员替换时提交不一致的指令。
    !value.is_empty()
        && value.len() <= 128
        && value.parse::<f64>().is_ok_and(|score| {
            score.is_finite()
                && (score != 0.0
                    || !value
                        .split(['e', 'E'])
                        .next()
                        .unwrap_or("")
                        .bytes()
                        .any(|byte| matches!(byte, b'1'..=b'9')))
        })
}
fn list_version(values: &[Vec<u8>]) -> String {
    let mut hash = Sha256::new();
    for value in values {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value);
    }
    format!("{:x}", hash.finalize())
}
fn check_key(key: &[u8]) -> Result<()> {
    if key.len() > 4096 {
        bail!("REDIS_KEY_LIMIT");
    }
    Ok(())
}
fn key_bytes(key: &str) -> Result<Vec<u8>> {
    if key.len() > 6000 {
        bail!("REDIS_KEY_LIMIT");
    }
    let bytes = STANDARD.decode(key)?;
    check_key(&bytes)?;
    Ok(bytes)
}
#[derive(Serialize)]
struct Blob {
    data: String,
    text: Option<String>,
    size: usize,
    truncated: bool,
}
fn blob(bytes: &[u8], limit: usize) -> Blob {
    let prefix = &bytes[..bytes.len().min(limit)];
    Blob {
        data: STANDARD.encode(prefix),
        text: std::str::from_utf8(prefix).ok().map(str::to_owned),
        size: bytes.len(),
        truncated: bytes.len() > limit,
    }
}
fn console_command(args: Vec<String>) -> Result<Cmd> {
    if args.is_empty() || args.len() > 8 || args.iter().any(|s| s.len() > 4096) {
        bail!("REDIS_COMMAND_BLOCKED");
    }
    let name = args[0].to_ascii_uppercase();
    let valid = match name.as_str() {
        "PING" | "DBSIZE" => args.len() == 1,
        "INFO" => {
            args.len() == 1
                || (args.len() == 2
                    && ["server", "memory", "stats", "replication", "keyspace"]
                        .contains(&args[1].to_ascii_lowercase().as_str()))
        }
        "TYPE" | "TTL" | "PTTL" | "EXISTS" | "STRLEN" | "HLEN" | "LLEN" | "SCARD" | "ZCARD" => {
            args.len() == 2
        }
        _ => false,
    };
    if !valid {
        bail!("REDIS_COMMAND_BLOCKED");
    }
    let mut cmd = redis::cmd(&name);
    for arg in &args[1..] {
        cmd.arg(arg);
    }
    Ok(cmd)
}
fn display_value(value: Value, depth: usize) -> serde_json::Value {
    if depth > 8 {
        return "…".into();
    }
    match value {
        Value::Nil => serde_json::Value::Null,
        Value::Int(n) => n.into(),
        Value::BulkString(bytes) => serde_json::to_value(blob(&bytes, PREVIEW)).unwrap_or_default(),
        Value::SimpleString(s) => s.into(),
        Value::Okay => "OK".into(),
        Value::Array(values) => values
            .into_iter()
            .take(200)
            .map(|v| display_value(v, depth + 1))
            .collect(),
        _ => "REDIS_UNSUPPORTED_REPLY".into(),
    }
}
#[derive(Serialize, Deserialize)]
struct Credential {
    target: String,
    password: String,
}
fn service(app: &tauri::AppHandle) -> String {
    format!("{}.redis", app.config().identifier)
}
#[tauri::command]
pub async fn redis_credential(
    app: tauri::AppHandle,
    config: Config,
    password: Option<String>,
    remove: bool,
) -> Result<Option<String>, String> {
    config.validate().map_err(fail)?;
    let reference = if remove {
        config
            .credential_id
            .clone()
            .ok_or("REDIS_CREDENTIAL_MISSING")?
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    let bytes = if remove {
        None
    } else {
        let password = password.ok_or("REDIS_CREDENTIAL_MISSING")?;
        if password.len() > 2048 {
            return Err("REDIS_CREDENTIAL_SIZE".into());
        }
        Some(
            serde_json::to_vec(&Credential {
                target: config.target().await.map_err(fail)?,
                password,
            })
            .map_err(fail)?,
        )
    };
    let service = service(&app);
    let id = reference.clone();
    tokio::task::spawn_blocking(move || {
        crate::redis_credentials::access(&service, &id, Some(bytes))
    })
    .await
    .map_err(fail)?
    .map_err(|_| "REDIS_CREDENTIAL_FAILED")?;
    Ok(if remove { None } else { Some(reference) })
}
#[tauri::command]
pub async fn redis_connect(
    app: tauri::AppHandle,
    config: Config,
    password: Option<String>,
) -> Result<serde_json::Value, String> {
    config.validate().map_err(fail)?;
    if password.as_ref().is_some_and(|p| p.len() > 2048) {
        return Err("REDIS_CREDENTIAL_SIZE".into());
    }
    let state = app.state::<RedisState>();
    let opening = {
        let connections = state.connections.lock().await;
        state.reserve(connections.len())?
    };
    let target = config.target().await.map_err(fail)?;
    let password = if password.is_some() {
        password
    } else if let Some(reference) = config.credential_id.clone() {
        let service = service(&app);
        let bytes = tokio::task::spawn_blocking(move || {
            crate::redis_credentials::access(&service, &reference, None)
        })
        .await
        .map_err(fail)?
        .map_err(|_| "REDIS_CREDENTIAL_FAILED")?
        .ok_or("REDIS_CREDENTIAL_MISSING")?;
        let credential: Credential =
            serde_json::from_slice(&bytes).map_err(|_| "REDIS_CREDENTIAL_FAILED")?;
        if credential.target != target {
            return Err("REDIS_CREDENTIAL_TARGET_CHANGED".into());
        }
        Some(credential.password)
    } else {
        None
    };
    let prepared = if let Some(target) = &config.ssh_target {
        Some(crate::ssh_auth::prepare(&app, target).await.map_err(fail)?)
    } else {
        None
    };
    // Reserve a slot without holding the connection map during SSH prompts or network I/O. 预留槽位，避免 SSH 提示及网络读写长期占用连接表锁。
    let connection = Connection::open(config, password, Some(target), prepared)
        .await
        .map_err(fail)?;
    let handle = uuid::Uuid::new_v4().to_string();
    let db = connection.db.load(Ordering::Relaxed);
    let mut connections = state.connections.lock().await;
    connections.insert(handle.clone(), Arc::new(connection));
    drop(opening);
    Ok(serde_json::json!({"handle":handle,"db":db}))
}
#[tauri::command]
pub async fn redis_reconnect(
    app: tauri::AppHandle,
    handle: String,
) -> Result<serde_json::Value, String> {
    let state = app.state::<RedisState>();
    let (previous, opening) = {
        let mut connections = state.connections.lock().await;
        let previous = connections.remove(&handle).ok_or("REDIS_RECONNECT")?;
        let opening = state.reserve(connections.len())?;
        (previous, opening)
    };
    previous.stop();
    let mut config = previous.config.clone();
    config.db = previous.db.load(Ordering::Relaxed) as u16;
    let prepared = if let Some(target) = &config.ssh_target {
        Some(crate::ssh_auth::prepare(&app, target).await.map_err(fail)?)
    } else {
        None
    };
    // A new transport must still resolve to the original target before password reuse. 复用密码前，新传输仍必须解析到原目标。
    let connection = Connection::open(
        config,
        previous.password.clone(),
        Some(previous.target.clone()),
        prepared,
    )
    .await
    .map_err(fail)?;
    let handle = uuid::Uuid::new_v4().to_string();
    let db = connection.db.load(Ordering::Relaxed);
    let mut connections = state.connections.lock().await;
    connections.insert(handle.clone(), Arc::new(connection));
    drop(opening);
    Ok(serde_json::json!({ "handle": handle, "db": db }))
}
#[tauri::command]
pub async fn redis_request(
    app: tauri::AppHandle,
    handle: String,
    request: Request,
) -> Result<serde_json::Value, String> {
    let state = app.state::<RedisState>();
    let connection = state
        .connections
        .lock()
        .await
        .get(&handle)
        .cloned()
        .ok_or("REDIS_RECONNECT")?;
    connection.request(request).await.map_err(fail)
}
#[tauri::command]
pub async fn redis_writable(
    app: tauri::AppHandle,
    handle: String,
    writable: bool,
) -> Result<(), String> {
    let state = app.state::<RedisState>();
    let connection = state
        .connections
        .lock()
        .await
        .get(&handle)
        .cloned()
        .ok_or("REDIS_RECONNECT")?;
    connection.writable.store(writable, Ordering::Release);
    Ok(())
}
#[tauri::command]
pub async fn redis_disconnect(app: tauri::AppHandle, handle: String) {
    if let Some(connection) = app
        .state::<RedisState>()
        .connections
        .lock()
        .await
        .remove(&handle)
    {
        connection.stop();
    }
}
#[tauri::command]
pub fn redis_guard(app: tauri::AppHandle, id: String, active: bool) -> Result<(), String> {
    uuid::Uuid::parse_str(&id).map_err(fail)?;
    let state = app.state::<RedisState>();
    let mut dirty = state.dirty.lock().map_err(fail)?;
    if active {
        dirty.insert(id);
    } else {
        dirty.remove(&id);
    }
    Ok(())
}
#[tauri::command]
pub fn redis_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub async fn redis_pick_ca(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("PEM", &["pem", "crt", "cer"])
            .blocking_pick_file()
            .map(|path| {
                path.into_path()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(fail)
            })
            .transpose()
    })
    .await
    .map_err(fail)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        net::TcpListener,
        process::{Child, Command, Stdio},
    };
    fn collection(key: &str, change: serde_json::Value) -> Request {
        serde_json::from_value(serde_json::json!({"op":"collection", "key":STANDARD.encode(key), "db":0, "change":change})).unwrap()
    }
    #[test]
    fn collection_inputs_bound_payloads_scores_indexes_and_snapshot_identity() {
        for value in [
            "0",
            "-0",
            "0e-999",
            "1.25",
            "+.5",
            "1e-20",
            "-1.2345678901234567e100",
        ] {
            assert!(valid_score(value));
        }
        for value in [
            "",
            " ",
            " 1",
            "0x12",
            "NaN",
            "inf",
            "-Infinity",
            "1e999",
            "1e-999",
            "-1e-999",
            "1,2",
        ] {
            assert!(!valid_score(value));
        }
        let change = |value| serde_json::from_value::<CollectionChange>(value).unwrap();
        assert!(change(
            serde_json::json!({"kind":"zset","action":"create","value":"","score":"NaN"})
        )
        .validate()
        .is_err());
        assert!(change(serde_json::json!({"kind":"list","action":"update","value":"","expected":"version","index":10000})).validate().is_err());
        assert!(
            change(serde_json::json!({"kind":"set","action":"delete","member":""}))
                .validate()
                .is_err()
        );
        assert!(change(serde_json::json!({"kind":"set","action":"create","value":STANDARD.encode(vec![b'x'; PREVIEW+1])})).validate().is_err());
        assert!(
            change(serde_json::json!({"kind":"string","action":"create","value":""}))
                .validate()
                .is_err()
        );
        assert!(change(
            serde_json::json!({"kind":"list","action":"create","value":"","position":"middle"})
        )
        .validate()
        .is_err());
        assert_ne!(
            list_version(&[b"ab".to_vec(), b"c".to_vec()]),
            list_version(&[b"a".to_vec(), b"bc".to_vec()])
        );
    }
    #[test]
    #[ignore = "requires redis-server; uses a disposable loopback server"]
    fn collection_creation_permissions_collisions_and_empty_members() {
        let server = server(false);
        runtime().block_on(async {
            let connection = open(&server).await;
            for kind in ["list", "set", "zset"] {
                let create = || collection(kind, serde_json::json!({"kind":kind,"action":"create","value":"","score":"1.25","position":"tail"}));
                assert!(connection.request(create()).await.unwrap_err().to_string().contains("REDIS_READ_ONLY"));
                connection.writable.store(true, Ordering::Release);
                connection.request(create()).await.unwrap();
                let data = connection.request(read(kind,None)).await.unwrap();
                assert_eq!(data["size"],1);
                assert_eq!(data["items"][0]["text"],"");
                assert!(connection.request(create()).await.unwrap_err().to_string().contains("REDIS_NAME_EXISTS"));
                let mut wrong_db = serde_json::json!({"op":"collection","key":STANDARD.encode(kind),"db":1,"change":{"kind":kind,"action":"add","value":"","score":"0"}});
                assert!(connection.request(serde_json::from_value(wrong_db.take()).unwrap()).await.unwrap_err().to_string().contains("REDIS_DB_CHANGED"));
                connection.writable.store(false, Ordering::Release);
            }
            assert_eq!(connection.request(read("zset",None)).await.unwrap()["items"][1]["text"],"1.25");
        });
    }
    #[test]
    #[ignore = "requires redis-server; uses a disposable loopback server"]
    fn list_edits_preserve_duplicate_positions_ttl_and_reject_changed_snapshots() {
        let server = server(false);
        runtime().block_on(async {
            let connection = Arc::new(open(&server).await);
            connection.writable.store(true, Ordering::Release);
            seed(&connection, &["RPUSH","list","same","middle","same","tail"]).await;
            seed(&connection, &["PEXPIRE","list","600000"]).await;
            let version = connection.request(read("list",None)).await.unwrap()["version"].as_str().unwrap().to_owned();
            connection.request(collection("list",serde_json::json!({"kind":"list","action":"delete","index":2,"expected":version}))).await.unwrap();
            let data = connection.request(read("list",None)).await.unwrap();
            assert_eq!(data["items"].as_array().unwrap().iter().map(|v|v["text"].as_str().unwrap()).collect::<Vec<_>>(),vec!["same","middle","tail"]);
            assert!(data["ttl"].as_i64().unwrap()>590000);
            assert!(connection.request(collection("list",serde_json::json!({"kind":"list","action":"update","index":1,"expected":version,"value":STANDARD.encode("wrong")}))).await.unwrap_err().to_string().contains("REDIS_CONFLICT"));
            let expected = data["version"].as_str().unwrap();
            let edit = |value:&str|collection("list",serde_json::json!({"kind":"list","action":"update","index":1,"expected":expected,"value":STANDARD.encode(value)}));
            let (left,right) = tokio::join!(connection.request(edit("左")),connection.request(edit("右")));
            assert_eq!(usize::from(left.is_ok())+usize::from(right.is_ok()),1);
            connection.request(collection("list",serde_json::json!({"kind":"list","action":"add","position":"head","value":STANDARD.encode("first")}))).await.unwrap();
            connection.request(collection("list",serde_json::json!({"kind":"list","action":"add","position":"tail","value":STANDARD.encode("last")}))).await.unwrap();
            let data = connection.request(read("list",None)).await.unwrap();
            assert_eq!(data["items"][0]["text"],"first");
            assert_eq!(data["items"][4]["text"],"last");
            let outsider = open(&server).await;
            seed(&outsider,&["LPUSH","list","shift"]).await;
            assert!(connection.request(collection("list",serde_json::json!({"kind":"list","action":"delete","index":1,"expected":data["version"]}))).await.unwrap_err().to_string().contains("REDIS_CONFLICT"));
            seed(&connection,&["RPUSH","big","a"]).await;
            {
                let mut wire=connection.wire.lock().await;
                connection.query(&mut wire,redis::cmd("RPUSH").arg("big").arg(vec![b'x'; PREVIEW]),true).await.unwrap();
                let mut command=redis::cmd("RPUSH"); command.arg("many");
                for _ in 0..=LIST_EDIT_MEMBERS {command.arg("x");}
                connection.query(&mut wire,&command,true).await.unwrap();
            }
            for key in ["big","many"] {
                assert!(connection.request(read(key,None)).await.unwrap()["version"].is_null());
                assert!(connection.request(collection(key,serde_json::json!({"kind":"list","action":"delete","index":0,"expected":"old"}))).await.unwrap_err().to_string().contains("REDIS_LIST_EDIT_LIMIT"));
                connection.request(collection(key,serde_json::json!({"kind":"list","action":"add","value":""}))).await.unwrap();
            }
            seed(&connection,&["RPUSH","single","only"]).await;
            let data=connection.request(read("single",None)).await.unwrap();
            connection.request(collection("single",serde_json::json!({"kind":"list","action":"delete","index":0,"expected":data["version"]}))).await.unwrap();
            assert!(connection.request(read("single",None)).await.unwrap_err().to_string().contains("REDIS_KEY_MISSING"));
        });
    }
    #[test]
    #[ignore = "requires redis-server; uses a disposable loopback server"]
    fn set_and_zset_members_preserve_ttl_reject_duplicates_and_stale_scores() {
        let server = server(false);
        runtime().block_on(async {
            let connection=open(&server).await;
            connection.writable.store(true,Ordering::Release);
            for kind in ["set","zset"] {
                connection.request(collection(kind,serde_json::json!({"kind":kind,"action":"create","value":STANDARD.encode("original"),"score":"1.25"}))).await.unwrap();
                seed(&connection,&["PEXPIRE",kind,"600000"]).await;
                let expected=if kind=="set" {"present"}else{"1.25"};
                connection.request(collection(kind,serde_json::json!({"kind":kind,"action":"update","member":STANDARD.encode("original"),"value":STANDARD.encode("中文"),"score":"-2.5","expected":expected}))).await.unwrap();
                let data=connection.request(read(kind,None)).await.unwrap();
                assert_eq!(data["size"],1);
                assert_eq!(data["items"][0]["text"],"中文");
                if kind == "zset" {
                    assert!(connection.request(collection(kind,serde_json::json!({"kind":kind,"action":"update","member":STANDARD.encode("中文"),"value":STANDARD.encode("replacement"),"score":"1e-999","expected":"-2.5"}))).await.unwrap_err().to_string().contains("REDIS_INVALID_SCORE"));
                    let unchanged = connection.request(read(kind,None)).await.unwrap();
                    assert_eq!(unchanged["items"][0]["text"],"中文");
                    assert_eq!(unchanged["items"][1]["text"],"-2.5");
                }
                assert!(data["ttl"].as_i64().unwrap()>590000);
                assert!(connection.request(collection(kind,serde_json::json!({"kind":kind,"action":"add","value":STANDARD.encode("中文"),"score":"9"}))).await.unwrap_err().to_string().contains("REDIS_MEMBER_EXISTS"));
                assert!(connection.request(collection(kind,serde_json::json!({"kind":kind,"action":"update","member":STANDARD.encode("original"),"value":"","score":"9","expected":expected}))).await.unwrap_err().to_string().contains("REDIS_CONFLICT"));
                connection.request(collection(kind,serde_json::json!({"kind":kind,"action":"add","value":"","score":"3"}))).await.unwrap();
                let expected=if kind=="set" {"present"}else{"-2.5"};
                assert!(connection.request(collection(kind,serde_json::json!({"kind":kind,"action":"update","member":STANDARD.encode("中文"),"value":"","score":"9","expected":expected}))).await.unwrap_err().to_string().contains("REDIS_MEMBER_EXISTS"));
                connection.request(collection(kind,serde_json::json!({"kind":kind,"action":"delete","member":STANDARD.encode("中文"),"expected":expected}))).await.unwrap();
                if kind=="zset" {
                    assert!(connection.request(collection(kind,serde_json::json!({"kind":kind,"action":"update","member":"","value":"","score":"8","expected":"2"}))).await.unwrap_err().to_string().contains("REDIS_CONFLICT"));
                    connection.request(collection(kind,serde_json::json!({"kind":kind,"action":"update","member":"","value":"","score":"0e-999","expected":"3"}))).await.unwrap();
                }
                connection.request(collection(kind,serde_json::json!({"kind":kind,"action":"delete","member":"","expected":if kind=="set" {"present"}else{"0"}}))).await.unwrap();
                assert!(connection.request(read(kind,None)).await.unwrap_err().to_string().contains("REDIS_KEY_MISSING"));
            }
        });
    }
    #[tokio::test]
    async fn opening_slots_are_bounded_released_and_leave_other_connections_accessible() {
        let state = RedisState::default();
        let mut slots = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            let connections = state.connections.lock().await;
            slots.push(state.reserve(connections.len()).unwrap());
        }
        assert!(state.busy());
        assert!(state.connections.try_lock().is_ok());
        assert!(state.reserve(0).is_err());
        slots.pop();
        slots.push(state.reserve(0).unwrap());
        drop(slots);
        assert!(!state.busy());
        assert_eq!(state.opening.load(Ordering::SeqCst), 0);
        assert!(state.reserve(MAX_CONNECTIONS).is_err());
    }
    struct Server {
        child: Child,
        _root: tempfile::TempDir,
        config: Config,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
    }
    fn server(tls: bool) -> Server {
        let root = tempfile::tempdir().unwrap();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut command = Command::new(
            utermd_local::resolve_program("redis-server")
                .expect("Redis test server must be installed"),
        );
        command
            .args([
                "--bind",
                "127.0.0.1",
                "--save",
                "",
                "--appendonly",
                "no",
                "--requirepass",
                "uterm-redis-test",
                "--dir",
            ])
            .arg(root.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let cert = root.path().join("server.crt");
        let key = root.path().join("server.key");
        if tls {
            let status = Command::new("openssl")
                .args([
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-days",
                    "1",
                    "-subj",
                    "/CN=redis.test",
                    "-addext",
                    "subjectAltName=DNS:redis.test,IP:127.0.0.1",
                    "-addext",
                    "basicConstraints=critical,CA:FALSE",
                    "-keyout",
                ])
                .arg(&key)
                .arg("-out")
                .arg(&cert)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success());
            command
                .args([
                    "--port",
                    "0",
                    "--tls-port",
                    &port.to_string(),
                    "--tls-auth-clients",
                    "no",
                    "--tls-cert-file",
                ])
                .arg(&cert)
                .arg("--tls-key-file")
                .arg(&key)
                .arg("--tls-ca-cert-file")
                .arg(&cert);
        } else {
            command.args(["--port", &port.to_string()]);
        }
        let mut child = command.spawn().unwrap();
        for _ in 0..100 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            assert!(child.try_wait().unwrap().is_none(), "Redis fixture exited");
            std::thread::sleep(Duration::from_millis(20));
        }
        Server {
            child,
            _root: root,
            config: Config {
                id: uuid::Uuid::new_v4().to_string(),
                name: "fixture".into(),
                host: "127.0.0.1".into(),
                port,
                db: 0,
                username: "".into(),
                tls,
                ca_file: if tls {
                    cert.to_string_lossy().into_owned()
                } else {
                    String::new()
                },
                server_name: if tls {
                    "redis.test".into()
                } else {
                    String::new()
                },
                ssh_host: String::new(),
                ssh_target: None,
                credential_id: None,
            },
        }
    }
    async fn open(server: &Server) -> Connection {
        Connection::open(
            server.config.clone(),
            Some("uterm-redis-test".into()),
            None,
            None,
        )
        .await
        .unwrap()
    }
    async fn seed(connection: &Connection, args: &[&str]) {
        let mut cmd = redis::cmd(args[0]);
        for arg in &args[1..] {
            cmd.arg(arg);
        }
        let mut wire = connection.wire.lock().await;
        connection.query(&mut wire, &cmd, true).await.unwrap();
    }
    fn read(key: &str, field: Option<&str>) -> Request {
        Request::Read {
            key: STANDARD.encode(key),
            field: field.map(|s| STANDARD.encode(s)),
            cursor: "0".into(),
            offset: 0,
            pattern: "*".into(),
        }
    }
    fn save(key: &str, field: Option<&str>, value: &str, expected: Option<&str>) -> Request {
        Request::Save {
            key: STANDARD.encode(key),
            field: field.map(|s| STANDARD.encode(s)),
            value: STANDARD.encode(value),
            expected: expected.map(str::to_owned),
            db: 0,
        }
    }
    #[test]
    #[ignore = "requires redis-server with TLS and openssl; run pnpm test:redis"]
    fn direct_auth_scan_and_binary_values_remain_isolated() {
        let server = server(false);
        runtime().block_on(async {
            assert!(
                Connection::open(server.config.clone(), Some("incorrect".into()), None, None)
                    .await
                    .is_err()
            );
            let connection = open(&server).await;
            let empty = tokio::time::timeout(
                Duration::from_secs(2),
                connection.request(Request::Scan {
                    cursor: "0".into(),
                    pattern: "*".into(),
                }),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(empty["entries"], serde_json::json!([]));
            assert_eq!(empty["cursor"], "0");
            seed(&connection, &["SET", "中文:key", "hello"]).await;
            let page = connection
                .request(Request::Scan {
                    cursor: "0".into(),
                    pattern: "中文:*".into(),
                })
                .await
                .unwrap();
            assert_eq!(page["entries"][0]["key"]["text"], "中文:key");
            let mut wire = connection.wire.lock().await;
            connection
                .query(
                    &mut wire,
                    redis::cmd("SET")
                        .arg(&[0u8, 255][..])
                        .arg(&[0u8, 128, 255][..]),
                    true,
                )
                .await
                .unwrap();
            drop(wire);
            let data = connection
                .request(Request::Read {
                    key: STANDARD.encode([0u8, 255]),
                    field: None,
                    cursor: "0".into(),
                    offset: 0,
                    pattern: "*".into(),
                })
                .await
                .unwrap();
            assert!(data["value"]["text"].is_null());
            assert_eq!(data["value"]["data"], STANDARD.encode([0u8, 128, 255]));
            connection.request(Request::Select { db: 1 }).await.unwrap();
            assert!(connection.request(read("中文:key", None)).await.is_err());
            connection.stop();
            assert!(connection
                .request(Request::Console {
                    args: vec!["PING".into()]
                })
                .await
                .is_err());
        });
    }
    #[test]
    #[ignore = "requires redis-server with TLS and openssl; run pnpm test:redis"]
    fn writes_require_permission_preserve_ttl_and_reject_stale_values() {
        let server = server(false);
        runtime().block_on(async {
            let connection = Arc::new(open(&server).await);
            seed(&connection, &["SET", "key", "original", "EX", "600"]).await;
            let version = digest(b"original");
            assert!(connection
                .request(save("key", None, "new", Some(&version)))
                .await
                .unwrap_err()
                .to_string()
                .contains("READ_ONLY"));
            connection.writable.store(true, Ordering::Release);
            let (left, right) = tokio::join!(
                connection.request(save("key", None, "left", Some(&version))),
                connection.request(save("key", None, "right", Some(&version)))
            );
            assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
            let data = connection.request(read("key", None)).await.unwrap();
            assert!(data["ttl"].as_i64().unwrap() > 590000);
            assert_eq!(data["value"]["text"], "left");
            assert!(connection
                .request(save("key", None, "collision", None))
                .await
                .is_err());
            connection
                .request(save("empty", None, "", None))
                .await
                .unwrap();
            assert_eq!(
                connection.request(read("empty", None)).await.unwrap()["value"]["text"],
                ""
            );
            connection
                .request(save("hash", Some("field"), "one", None))
                .await
                .unwrap();
            assert!(connection
                .request(save("hash", Some("field"), "two", None))
                .await
                .is_err());
            connection
                .request(save("hash", Some("field"), "two", Some(&digest(b"one"))))
                .await
                .unwrap();
            assert_eq!(
                connection
                    .request(read("hash", Some("field")))
                    .await
                    .unwrap()["value"]["text"],
                "two"
            );
            assert!(connection
                .request(Request::Save {
                    key: STANDARD.encode("key"),
                    field: None,
                    value: STANDARD.encode("bad"),
                    expected: Some(digest(b"left")),
                    db: 1
                })
                .await
                .unwrap_err()
                .to_string()
                .contains("DB_CHANGED"));
        });
    }
    #[test]
    #[ignore = "requires redis-server with TLS and openssl; run pnpm test:redis"]
    fn collections_mutations_and_console_enforce_bounds() {
        let server = server(false);
        runtime().block_on(async {
            let connection = open(&server).await;
            connection.writable.store(true, Ordering::Release);
            for args in [
                &["RPUSH", "list", "a", "b"][..],
                &["SADD", "set", "x", "y"],
                &["ZADD", "zset", "1", "a", "2", "b"],
                &["HSET", "hash", "field", "value"],
            ] {
                seed(&connection, args).await;
            }
            for key in ["list", "set", "zset", "hash"] {
                let data = connection.request(read(key, None)).await.unwrap();
                assert!(data["items"].as_array().unwrap().len() >= 2);
            }
            seed(&connection, &["SET", "existing", "x"]).await;
            assert!(connection
                .request(Request::Mutate {
                    key: STANDARD.encode("list"),
                    action: "rename".into(),
                    argument: STANDARD.encode("existing"),
                    db: 0
                })
                .await
                .is_err());
            connection
                .request(Request::Mutate {
                    key: STANDARD.encode("list"),
                    action: "ttl".into(),
                    argument: "60".into(),
                    db: 0,
                })
                .await
                .unwrap();
            connection
                .request(Request::Mutate {
                    key: STANDARD.encode("list"),
                    action: "delete".into(),
                    argument: "".into(),
                    db: 0,
                })
                .await
                .unwrap();
            assert!(connection.request(read("list", None)).await.is_err());
            for args in [
                vec!["FLUSHALL"],
                vec!["EVAL", "return 1", "0"],
                vec!["MONITOR"],
                vec!["SELECT", "2"],
                vec!["CONFIG", "GET", "*"],
                vec!["INFO", "all"],
                vec!["GET", "large"],
            ] {
                assert!(console_command(args.into_iter().map(str::to_owned).collect()).is_err());
            }
            let mut wire = connection.wire.lock().await;
            connection
                .query(
                    &mut wire,
                    redis::cmd("SET")
                        .arg("large")
                        .arg(vec![b'x'; PREVIEW + 100]),
                    true,
                )
                .await
                .unwrap();
            drop(wire);
            let data = connection.request(read("large", None)).await.unwrap();
            assert!(data["version"].is_null());
            assert_eq!(data["value"]["size"], PREVIEW);
            assert!(connection
                .request(save("large", None, "replace", Some(&digest(b"old"))))
                .await
                .is_err());
        });
    }
    #[test]
    #[ignore = "requires redis-server with TLS and openssl; run pnpm test:redis"]
    fn tls_checks_ca_and_original_server_name() {
        let server = server(true);
        runtime().block_on(async {
            let connection = open(&server).await;
            assert!(connection
                .request(Request::Console {
                    args: vec!["PING".into()]
                })
                .await
                .is_ok());
            let mut wrong = server.config.clone();
            wrong.server_name = "wrong.test".into();
            assert!(
                Connection::open(wrong, Some("uterm-redis-test".into()), None, None)
                    .await
                    .is_err()
            );
            let mut untrusted = server.config.clone();
            untrusted.ca_file.clear();
            assert!(
                Connection::open(untrusted, Some("uterm-redis-test".into()), None, None)
                    .await
                    .is_err()
            );
            let mut changed = server.config.clone();
            changed.port = changed.port.saturating_add(1);
            assert_ne!(
                server.config.target().await.unwrap(),
                changed.target().await.unwrap()
            );
        });
    }
    #[test]
    fn timed_out_writes_are_uncertain_and_never_retried() {
        runtime().block_on(async {
            use tokio::io::AsyncWriteExt;
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let executions = Arc::new(AtomicUsize::new(0));
            let observed = executions.clone();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                loop {
                    let mut bytes = Vec::new();
                    let command = loop {
                        let Ok(byte) = socket.read_u8().await else {
                            return;
                        };
                        bytes.push(byte);
                        assert!(bytes.len() < 4096);
                        if let Ok(value) = redis::parse_redis_value(&bytes) {
                            let args: Vec<Vec<u8>> = redis::from_redis_value(value).unwrap();
                            break String::from_utf8(args[0].clone()).unwrap();
                        }
                    };
                    let response: &[u8] = match command.as_str() {
                        "TYPE" => b"+string\r\n",
                        "STRLEN" => b":8\r\n",
                        "GET" => b"$8\r\noriginal\r\n",
                        "SET" => b"+QUEUED\r\n",
                        "EXEC" => {
                            observed.fetch_add(1, Ordering::SeqCst);
                            // Lose only the commit reply, after accepting EXEC. 接受 EXEC 后仅丢失提交响应。
                            std::future::pending::<()>().await;
                            return;
                        }
                        _ => b"+OK\r\n",
                    };
                    if socket.write_all(response).await.is_err() {
                        return;
                    }
                }
            });
            let config = Config {
                id: uuid::Uuid::new_v4().to_string(),
                name: "timeout".into(),
                host: "127.0.0.1".into(),
                port,
                db: 0,
                username: String::new(),
                tls: false,
                ca_file: String::new(),
                server_name: String::new(),
                ssh_host: String::new(),
                ssh_target: None,
                credential_id: None,
            };
            let connection = Connection::open(config, None, None, None).await.unwrap();
            connection
                .wire
                .lock()
                .await
                .set_response_timeout(Duration::from_millis(250));
            connection.writable.store(true, Ordering::Release);
            let error = connection
                .request(save("key", None, "new", Some(&digest(b"original"))))
                .await
                .unwrap_err();
            assert!(
                error.to_string().contains("REDIS_WRITE_UNCERTAIN"),
                "{error}"
            );
            assert!(connection.dead.load(Ordering::Acquire));
            assert!(connection
                .request(save("key", None, "new", Some(&digest(b"original"))))
                .await
                .unwrap_err()
                .to_string()
                .contains("REDIS_RECONNECT"));
            assert_eq!(executions.load(Ordering::SeqCst), 1);
            server.abort();
        });
    }
    #[test]
    fn transport_budget_and_configuration_reject_oversized_or_unsafe_input() {
        runtime().block_on(async {
            let (stream, mut peer) = tokio::io::duplex(1024);
            let budget = Arc::new(AtomicUsize::new(16));
            let mut stream = LimitedStream {
                stream: Box::new(stream),
                budget,
            };
            let sender = tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                let _ = peer.write_all(&[1; 32]).await;
            });
            let mut bytes = Vec::new();
            assert!(stream.read_to_end(&mut bytes).await.is_err());
            assert_eq!(bytes.len(), 16);
            sender.abort();
            for host in ["-oProxyCommand=x", "host name", "$(id)", "host\n"] {
                assert!(!valid_host(host));
            }
            assert!(key_bytes(&STANDARD.encode(vec![0u8; 4097])).is_err());
            assert!(crate::redis_credentials::validate_reference("not-an-id").is_err());
        });
    }
}
