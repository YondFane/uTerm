use anyhow::{anyhow, bail, Context, Result};
use russh_sftp::{
    client::{error::Error as SftpError, rawsession::RawSftpSession},
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex as AsyncMutex,
};
use utermd_local::{
    ssh::{validate_host, SshTarget},
    BackgroundChild,
};

const CHUNK: usize = 32 * 1024;
const PREVIEW_LIMIT: usize = 8 * 1024 * 1024;
const TEXT_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Default)]
pub struct SshFiles {
    roots: AsyncMutex<HashMap<String, Arc<RemoteFs>>>,
    transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
impl SshFiles {
    pub fn busy(&self) -> bool {
        self.transfers
            .lock()
            .map_or(true, |tasks| !tasks.is_empty())
    }
    pub fn cancel_all(&self) {
        if let Ok(tasks) = self.transfers.lock() {
            for task in tasks.values() {
                task.store(true, Ordering::Release);
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemoteRoot {
    pub connection: SshTarget,
    pub path: String,
    pub identity: String,
}
impl RemoteRoot {
    fn key(&self) -> Result<String> {
        Ok(digest(&serde_json::to_vec(self)?))
    }
    fn validate(&self) -> Result<()> {
        self.connection.validate()?;
        if self.path.is_empty()
            || self.path.len() > 4096
            || self.path.contains(['\0', '\r', '\n'])
            || self.identity.len() != 64
            || !self.identity.bytes().all(|c| c.is_ascii_hexdigit())
        {
            bail!("SSH_INVALID_ROOT");
        }
        Ok(())
    }
}
struct RemoteFs {
    root: RemoteRoot,
    sftp: RawSftpSession,
    replace: bool,
    fsync: bool,
    child: Mutex<BackgroundChild>,
    stderr: Arc<Mutex<Vec<u8>>>,
    writes: AsyncMutex<()>,
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn failure(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn is_missing(error: &SftpError) -> bool {
    matches!(error, SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile)
}
fn is_eof(error: &SftpError) -> bool {
    matches!(error, SftpError::Status(status) if status.status_code == StatusCode::Eof)
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        bail!("SSH_TRANSFER_CANCELLED");
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn pipe_file<T: Into<std::os::fd::OwnedFd>>(pipe: T) -> tokio::fs::File {
    tokio::fs::File::from_std(std::fs::File::from(pipe.into()))
}
#[cfg(windows)]
pub(crate) fn pipe_file<T: Into<std::os::windows::io::OwnedHandle>>(pipe: T) -> tokio::fs::File {
    tokio::fs::File::from_std(std::fs::File::from(pipe.into()))
}
pub(crate) fn base_command() -> Result<Command> {
    let mut command = Command::new(utermd_local::ssh::program()?);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
        .env_remove("SSH_ASKPASS")
        .env("SSH_ASKPASS_REQUIRE", "never");
    Ok(command)
}
pub(crate) struct EffectiveSsh {
    pub identity: String,
    pub hostname: String,
    pub user: String,
    pub port: String,
}
pub(crate) async fn effective_identity(host: &str) -> Result<EffectiveSsh> {
    validate_host(host)?;
    let mut command = base_command()?;
    command.args(["-G", "--", host]);
    let mut child = BackgroundChild::spawn(&mut command)?;
    drop(child.take_stdin());
    let mut stdout =
        pipe_file(child.take_stdout().context("SSH_PIPE_FAILED")?).take(1024 * 1024 + 1);
    let mut stderr = pipe_file(child.take_stderr().context("SSH_PIPE_FAILED")?).take(16 * 1024);
    let mut output = Vec::new();
    let mut errors = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), async {
        let (out, err) = tokio::join!(
            stdout.read_to_end(&mut output),
            stderr.read_to_end(&mut errors)
        );
        out?;
        err?;
        loop {
            if let Some(status) = child.try_wait()? {
                if !status.success() {
                    bail!("SSH_CONFIG_FAILED: {}", String::from_utf8_lossy(&errors));
                }
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("SSH_TIMEOUT")??;
    if output.len() > 1024 * 1024 {
        bail!("SSH_CONFIG_FAILED");
    }
    let text = std::str::from_utf8(&output)?;
    let fields: Vec<_> = text
        .lines()
        .filter(|line| {
            [
                "hostname ",
                "user ",
                "port ",
                "hostkeyalias ",
                "proxyjump ",
                "proxycommand ",
                "userknownhostsfile ",
            ]
            .iter()
            .any(|key| line.starts_with(key))
        })
        .collect();
    if !fields.iter().any(|line| line.starts_with("hostname ")) {
        bail!("SSH_CONFIG_FAILED");
    }
    let option = |name: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(name))
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("SSH_CONFIG_FAILED"))
    };
    Ok(EffectiveSsh {
        identity: digest(fields.join("\n").as_bytes()),
        hostname: option("hostname ")?,
        user: option("user ")?,
        port: option("port ")?,
    })
}
fn canonical(path: &str, windows: bool) -> Result<String> {
    if path.is_empty() || path.contains(['\0', '\r', '\n']) {
        bail!("SSH_INVALID_ROOT");
    }
    let mut value = if windows {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    };
    if windows {
        if value.starts_with('/') && value.as_bytes().get(2) == Some(&b':') {
            value.remove(0);
        }
        if value.starts_with("//")
            || !value
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
            || value.as_bytes().get(1) != Some(&b':')
            || value.as_bytes().get(2) != Some(&b'/')
        {
            bail!("SSH_INVALID_ROOT");
        }
        value.replace_range(..1, &value[..1].to_ascii_uppercase());
    } else if !value.starts_with('/') {
        bail!("SSH_INVALID_ROOT");
    }
    if value.split('/').any(|part| part == ".." || part == ".") {
        bail!("SSH_INVALID_ROOT");
    }
    while value.ends_with('/') && value.len() > if windows { 3 } else { 1 } {
        value.pop();
    }
    Ok(value)
}
fn relative(path: &str) -> Result<()> {
    if path.len() > 4096
        || (!path.is_empty()
            && path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".."))
        || path.contains(['\\', ':', '\0', '\r', '\n'])
    {
        bail!("SSH_PATH_OUTSIDE_ROOT");
    }
    Ok(())
}
fn within(root: &str, path: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|tail| root.ends_with('/') || tail.starts_with('/'))
}
fn join(root: &str, path: &str) -> String {
    if path.is_empty() {
        root.to_owned()
    } else {
        format!("{}/{path}", root.trim_end_matches('/'))
    }
}

impl RemoteFs {
    async fn connect(connection: SshTarget, expected: Option<&RemoteRoot>) -> Result<Arc<Self>> {
        connection.validate()?;
        let effective = effective_identity(&connection.host).await?;
        if expected.is_some_and(|root| root.identity != effective.identity) {
            bail!("SSH_TARGET_CHANGED");
        }
        let mut command = base_command()?;
        command.args([
            "-T",
            "-S",
            "none",
            "-o",
            "ControlMaster=no",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "ForwardAgent=no",
            "-o",
            "ForwardX11=no",
            "-o",
            "RemoteCommand=none",
            "-o",
            "ConnectTimeout=15",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            &format!("HostName={}", effective.hostname),
            "-l",
            &effective.user,
            "-p",
            &effective.port,
            "-s",
            "--",
            &connection.host,
            "sftp",
        ]);
        let mut child = BackgroundChild::spawn(&mut command)?;
        let stream = tokio::io::join(
            pipe_file(child.take_stdout().context("SSH_PIPE_FAILED")?),
            pipe_file(child.take_stdin().context("SSH_PIPE_FAILED")?),
        );
        let mut errors = pipe_file(child.take_stderr().context("SSH_PIPE_FAILED")?);
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let capture = stderr.clone();
        tokio::spawn(async move {
            let mut bytes = [0; 4096];
            while let Ok(count) = errors.read(&mut bytes).await {
                if count == 0 {
                    break;
                }
                if let Ok(mut saved) = capture.lock() {
                    saved.extend_from_slice(&bytes[..count]);
                    let excess = saved.len().saturating_sub(16 * 1024);
                    saved.drain(..excess);
                }
            }
        });
        let sftp = RawSftpSession::new(stream);
        sftp.set_timeout(15);
        let version = sftp.init().await.map_err(|error| {
            anyhow!(
                "SSH_SFTP_FAILED: {error}: {}",
                stderr
                    .lock()
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .unwrap_or_default()
            )
        })?;
        if version.version != 3 {
            bail!("SSH_SFTP_UNSUPPORTED");
        }
        let requested = if let Some(root) = expected {
            &root.path
        } else if connection.root.is_empty() {
            "."
        } else {
            &connection.root
        };
        let requested = if connection.os == "windows" {
            requested.replace('\\', "/")
        } else {
            requested.to_owned()
        };
        let path = canonical(
            &sftp
                .realpath(requested)
                .await?
                .files
                .first()
                .context("SSH_INVALID_ROOT")?
                .filename,
            connection.os == "windows",
        )?;
        if expected.is_some_and(|root| root.path != path) {
            bail!("SSH_TARGET_CHANGED");
        }
        if !sftp.stat(&path).await?.attrs.is_dir() {
            bail!("SSH_INVALID_ROOT");
        }
        Ok(Arc::new(Self {
            root: RemoteRoot {
                connection,
                path,
                identity: effective.identity,
            },
            sftp,
            replace: version.extensions.contains_key("posix-rename@openssh.com"),
            fsync: version.extensions.contains_key("fsync@openssh.com"),
            child: Mutex::new(child),
            stderr,
            writes: AsyncMutex::new(()),
        }))
    }
    fn alive(&self) -> Result<()> {
        if self
            .child
            .lock()
            .map_err(|_| anyhow!("SSH_DISCONNECTED"))?
            .try_wait()?
            .is_some()
        {
            bail!(
                "SSH_DISCONNECTED: {}",
                self.stderr
                    .lock()
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .unwrap_or_default()
            );
        }
        Ok(())
    }
    async fn resolve(&self, path: &str, mutate: bool) -> Result<String> {
        self.alive()?;
        relative(path)?;
        let root = canonical(
            &self
                .sftp
                .realpath(&self.root.path)
                .await?
                .files
                .first()
                .context("SSH_INVALID_ROOT")?
                .filename,
            self.root.connection.os == "windows",
        )?;
        if root != self.root.path {
            bail!("SSH_TARGET_CHANGED");
        }
        let requested = join(&root, path);
        let resolved = canonical(
            &self
                .sftp
                .realpath(&requested)
                .await?
                .files
                .first()
                .context("SSH_INVALID_ROOT")?
                .filename,
            self.root.connection.os == "windows",
        )?;
        if !within(&root, &resolved) {
            bail!("SSH_PATH_OUTSIDE_ROOT");
        }
        if mutate {
            let mut cursor = root.clone();
            for part in path.split('/').filter(|part| !part.is_empty()) {
                cursor = join(&cursor, part);
                if self.sftp.lstat(&cursor).await?.attrs.is_symlink() {
                    bail!("SSH_SYMLINK_READONLY");
                }
            }
        }
        Ok(resolved)
    }
    async fn exists(&self, path: &str) -> Result<Option<FileAttributes>> {
        match self.sftp.lstat(path).await {
            Ok(attrs) => Ok(Some(attrs.attrs)),
            Err(error) if is_missing(&error) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    async fn read_bytes(&self, path: &str, limit: usize) -> Result<(Vec<u8>, FileAttributes)> {
        let handle = self
            .sftp
            .open(path, OpenFlags::READ, FileAttributes::default())
            .await?
            .handle;
        let result = async {
            let attrs = self.sftp.fstat(&handle).await?.attrs;
            if !attrs.is_regular() {
                bail!("SSH_REGULAR_FILE_REQUIRED");
            }
            if attrs.size.is_some_and(|size| size > limit as u64) {
                bail!("SSH_FILE_TOO_LARGE");
            }
            let mut bytes = Vec::new();
            loop {
                match self
                    .sftp
                    .read(&handle, bytes.len() as u64, CHUNK as u32)
                    .await
                {
                    Ok(data) if !data.data.is_empty() => {
                        bytes.extend_from_slice(&data.data);
                        if bytes.len() > limit {
                            bail!("SSH_FILE_TOO_LARGE");
                        }
                    }
                    Ok(_) => break,
                    Err(error) if is_eof(&error) => break,
                    Err(error) => return Err(error.into()),
                }
            }
            Ok((bytes, attrs))
        }
        .await;
        let close = self.sftp.close(handle).await;
        let value = result?;
        close?;
        Ok(value)
    }
    async fn replace_temp(&self, temporary: &str, destination: &str) -> Result<()> {
        if !self.replace {
            bail!("SSH_SAFE_REPLACE_UNSUPPORTED");
        }
        let mut data = Vec::new();
        for path in [temporary, destination] {
            data.extend_from_slice(&(path.len() as u32).to_be_bytes());
            data.extend_from_slice(path.as_bytes());
        }
        match self.sftp.extended("posix-rename@openssh.com", data).await? {
            Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
            _ => bail!("SSH_SAFE_REPLACE_FAILED"),
        }
    }
    async fn save(&self, path: &str, text: &str, expected: &str, force: bool) -> Result<String> {
        if text.len() > TEXT_LIMIT || text.contains('\0') {
            bail!("SSH_FILE_TOO_LARGE");
        }
        if !self.replace {
            bail!("SSH_SAFE_REPLACE_UNSUPPORTED");
        }
        let _guard = self.writes.lock().await;
        let destination = self.resolve(path, true).await?;
        let (previous, attrs) = self.read_bytes(&destination, TEXT_LIMIT).await?;
        if attrs.permissions.is_some_and(|mode| mode & 0o222 == 0) {
            bail!("文件是只读的，未保存。");
        }
        if !force && digest(&previous) != expected {
            bail!("CONFLICT:文件已被其他程序修改。请重新读取，或确认覆盖磁盘版本。");
        }
        let parent = destination.rsplit_once('/').context("SSH_INVALID_ROOT")?.0;
        let temporary = join(parent, &format!(".uterm-{}", uuid::Uuid::new_v4()));
        let handle = self
            .sftp
            .open(
                &temporary,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes {
                    permissions: Some(0o600),
                    ..Default::default()
                },
            )
            .await?
            .handle;
        let result = async {
            for (index, chunk) in text.as_bytes().chunks(CHUNK).enumerate() {
                self.sftp
                    .write(&handle, (index * CHUNK) as u64, chunk.to_vec())
                    .await?;
            }
            self.sftp
                .fsetstat(
                    &handle,
                    FileAttributes {
                        permissions: attrs.permissions.map(|mode| mode & 0o777),
                        ..Default::default()
                    },
                )
                .await?;
            if self.fsync {
                self.sftp.fsync(&handle).await?;
            }
            self.sftp.close(&handle).await?;
            if self.resolve(path, true).await? != destination
                || self.read_bytes(&destination, TEXT_LIMIT).await?.0 != previous
            {
                bail!("CONFLICT:保存期间文件发生变化，请重新读取。");
            }
            self.replace_temp(&temporary, &destination).await?;
            Ok(digest(text.as_bytes()))
        }
        .await;
        if result.is_err() {
            let _ = self.sftp.close(handle).await;
            let _ = self.sftp.remove(&temporary).await;
        }
        result
    }
}
async fn remote(state: &SshFiles, root: &RemoteRoot) -> Result<Arc<RemoteFs>> {
    root.validate()?;
    let key = root.key()?;
    let mut roots = state.roots.lock().await;
    if let Some(remote) = roots.get(&key) {
        remote.alive()?;
        return Ok(remote.clone());
    }
    if roots.len() >= 16 {
        bail!("SSH_CONNECTION_LIMIT");
    }
    let remote = RemoteFs::connect(root.connection.clone(), Some(root)).await?;
    roots.insert(key, remote.clone());
    Ok(remote)
}

#[derive(Serialize)]
pub struct SshInfo {
    available: bool,
    aliases: Vec<String>,
}
fn aliases(path: &Path, seen: &mut HashSet<PathBuf>, values: &mut HashSet<String>, depth: usize) {
    if depth > 16 || seen.len() >= 128 {
        return;
    }
    let Ok(path) = path.canonicalize() else {
        return;
    };
    if !seen.insert(path.clone()) {
        return;
    }
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    if text.len() > 1024 * 1024 {
        return;
    }
    for line in text.lines() {
        let mut words = line.split('#').next().unwrap_or("").split_whitespace();
        let Some(key) = words.next() else {
            continue;
        };
        if key.eq_ignore_ascii_case("host") {
            for host in words {
                if validate_host(host).is_ok() {
                    values.insert(host.to_owned());
                }
            }
        } else if key.eq_ignore_ascii_case("include") {
            for include in words {
                let include = include
                    .trim_matches(char::from(34))
                    .trim_matches(char::from(39));
                let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .map(PathBuf::from)
                    .unwrap_or_default();
                let include = if let Some(tail) = include.strip_prefix("~/") {
                    home.join(tail)
                } else if Path::new(include).is_absolute() {
                    include.into()
                } else {
                    home.join(".ssh").join(include)
                };
                if let Some(pattern) = include.to_str() {
                    if let Ok(paths) = glob::glob(pattern) {
                        for file in paths.flatten() {
                            aliases(&file, seen, values, depth + 1);
                        }
                    }
                }
            }
        }
    }
}
#[tauri::command]
pub async fn ssh_info() -> Result<SshInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(PathBuf::from)
            .unwrap_or_default();
        let mut values = HashSet::new();
        aliases(
            &home.join(".ssh/config"),
            &mut HashSet::new(),
            &mut values,
            0,
        );
        let mut aliases: Vec<_> = values.into_iter().collect();
        aliases.sort();
        SshInfo {
            available: utermd_local::ssh::program().is_ok(),
            aliases,
        }
    })
    .await
    .map_err(failure)
}
#[tauri::command]
pub async fn ssh_files_open(
    state: tauri::State<'_, SshFiles>,
    connection: SshTarget,
    expected: Option<RemoteRoot>,
) -> Result<RemoteRoot, String> {
    let mut roots = state.roots.lock().await;
    if roots.len() >= 16 {
        return Err("SSH_CONNECTION_LIMIT".into());
    }
    let remote = RemoteFs::connect(connection, expected.as_ref())
        .await
        .map_err(failure)?;
    let root = remote.root.clone();
    roots.insert(root.key().map_err(failure)?, remote);
    Ok(root)
}
#[tauri::command]
pub async fn ssh_files_disconnect(
    state: tauri::State<'_, SshFiles>,
    connection_id: String,
) -> Result<(), String> {
    if state.busy() {
        return Err("SSH_TRANSFER_BUSY".into());
    }
    state
        .roots
        .lock()
        .await
        .retain(|_, remote| remote.root.connection.connection_id != connection_id);
    Ok(())
}
#[derive(Serialize)]
pub struct RemoteEntry {
    path: String,
    name: String,
    directory: bool,
    symlink: bool,
}
#[derive(Serialize)]
pub struct RemoteListing {
    entries: Vec<RemoteEntry>,
    partial: bool,
    skipped: usize,
}
#[tauri::command]
pub async fn ssh_files_list(
    state: tauri::State<'_, SshFiles>,
    root: RemoteRoot,
    path: String,
    hidden: bool,
) -> Result<RemoteListing, String> {
    async {
        let remote = remote(&state, &root).await?;
        let folder = remote.resolve(&path, false).await?;
        let handle = remote.sftp.opendir(folder).await?.handle;
        let result: Result<RemoteListing> = async {
            let mut listing = RemoteListing {
                entries: vec![],
                partial: false,
                skipped: 0,
            };
            loop {
                let packet = match remote.sftp.readdir(&handle).await {
                    Ok(packet) => packet,
                    Err(error) if is_eof(&error) => break,
                    Err(error) => return Err(error.into()),
                };
                for item in packet.files {
                    if item.filename == "."
                        || item.filename == ".."
                        || (!hidden && item.filename.starts_with('.'))
                    {
                        continue;
                    }
                    if relative(&item.filename).is_err()
                        || item.filename.contains('/')
                        || item.filename.is_empty()
                    {
                        listing.skipped += 1;
                        continue;
                    }
                    listing.entries.push(RemoteEntry {
                        path: join(&path, &item.filename)
                            .trim_start_matches('/')
                            .to_owned(),
                        name: item.filename,
                        directory: item.attrs.is_dir(),
                        symlink: item.attrs.is_symlink(),
                    });
                    if listing.entries.len() >= 2000 {
                        listing.partial = true;
                        break;
                    }
                }
                if listing.partial {
                    break;
                }
            }
            listing.entries.sort_by(|a, b| {
                b.directory
                    .cmp(&a.directory)
                    .then_with(|| a.name.cmp(&b.name))
            });
            Ok(listing)
        }
        .await;
        let close = remote.sftp.close(handle).await;
        let result = result?;
        close?;
        Ok::<_, anyhow::Error>(result)
    }
    .await
    .map_err(failure)
}
#[tauri::command]
pub async fn ssh_file_read(
    state: tauri::State<'_, SshFiles>,
    root: RemoteRoot,
    path: String,
) -> Result<crate::files::Document, String> {
    let remote = remote(&state, &root).await.map_err(failure)?;
    let resolved = remote.resolve(&path, false).await.map_err(failure)?;
    let (bytes, attrs) = remote
        .read_bytes(&resolved, PREVIEW_LIMIT)
        .await
        .map_err(failure)?;
    let linked = match remote.resolve(&path, true).await {
        Ok(_) => false,
        Err(error) if error.to_string().contains("SSH_SYMLINK_READONLY") => true,
        Err(error) => return Err(failure(error)),
    };
    let readonly =
        !remote.replace || linked || attrs.permissions.is_some_and(|mode| mode & 0o222 == 0);
    let mut document = crate::files::document_from_bytes(bytes, readonly)?;
    if !remote.replace {
        document.notice = Some("服务器不支持安全覆盖。请下载文件，或上传为新文件。".into());
    }
    Ok(document)
}
#[tauri::command]
pub async fn ssh_file_save(
    state: tauri::State<'_, SshFiles>,
    root: RemoteRoot,
    path: String,
    text: String,
    expected: String,
    force: bool,
) -> Result<String, String> {
    remote(&state, &root)
        .await
        .map_err(failure)?
        .save(&path, &text, &expected, force)
        .await
        .map_err(failure)
}
impl RemoteFs {
    async fn mutate(&self, path: String, action: String, name: String) -> Result<()> {
        let remote = self;
        let _guard = remote.writes.lock().await;
        let target = remote.resolve(&path, true).await?;
        if action == "delete" {
            if path.is_empty() {
                bail!("SSH_PATH_OUTSIDE_ROOT");
            }
            if remote.sftp.lstat(&target).await?.attrs.is_dir() {
                remote.sftp.rmdir(target).await?;
            } else {
                remote.sftp.remove(target).await?;
            }
            return Ok(());
        }
        relative(&name)?;
        if name.is_empty() || name.contains('/') || name != name.trim() {
            bail!("SSH_INVALID_NAME");
        }
        let parent = if action == "rename" && !path.is_empty() {
            target
                .rsplit_once('/')
                .context("SSH_INVALID_ROOT")?
                .0
                .to_owned()
        } else if ["file", "directory"].contains(&action.as_str())
            && remote.sftp.stat(&target).await?.attrs.is_dir()
        {
            target.clone()
        } else {
            bail!("SSH_INVALID_ACTION");
        };
        let destination = join(&parent, &name);
        if action == "rename" && destination == target {
            return Ok(());
        }
        if remote.exists(&destination).await?.is_some() {
            bail!("SSH_DESTINATION_EXISTS");
        }
        match action.as_str() {
            "file" => {
                let handle = remote
                    .sftp
                    .open(
                        destination,
                        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                        FileAttributes::default(),
                    )
                    .await?;
                remote.sftp.close(handle.handle).await?;
            }
            "directory" => {
                remote
                    .sftp
                    .mkdir(destination, FileAttributes::default())
                    .await?;
            }
            "rename" => {
                remote.sftp.rename(target, destination).await?;
            }
            _ => bail!("SSH_INVALID_ACTION"),
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn ssh_file_mutate(
    state: tauri::State<'_, SshFiles>,
    root: RemoteRoot,
    path: String,
    action: String,
    name: String,
) -> Result<(), String> {
    remote(&state, &root)
        .await
        .map_err(failure)?
        .mutate(path, action, name)
        .await
        .map_err(failure)
}

#[derive(Clone, Serialize)]
pub struct TransferProgress {
    pub id: String,
    pub name: String,
    pub completed: u64,
    pub total: u64,
    pub state: String,
}
struct TransferGuard<'a> {
    state: &'a SshFiles,
    id: String,
}
impl Drop for TransferGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut tasks) = self.state.transfers.lock() {
            tasks.remove(&self.id);
        }
    }
}
fn progress(
    events: &Channel<TransferProgress>,
    id: &str,
    name: &str,
    completed: u64,
    total: u64,
) -> Result<()> {
    events
        .send(TransferProgress {
            id: id.into(),
            name: name.into(),
            completed,
            total,
            state: "running".into(),
        })
        .map_err(|error| anyhow!("{error}"))
}
impl RemoteFs {
    async fn remote_digest(&self, path: &str, cancel: &AtomicBool) -> Result<String> {
        let handle = self
            .sftp
            .open(path, OpenFlags::READ, FileAttributes::default())
            .await?
            .handle;
        let result = async {
            if !self.sftp.fstat(&handle).await?.attrs.is_regular() {
                bail!("SSH_REGULAR_FILE_REQUIRED");
            }
            let mut hash = Sha256::new();
            let mut offset = 0;
            loop {
                cancelled(cancel)?;
                match self.sftp.read(&handle, offset, CHUNK as u32).await {
                    Ok(data) if !data.data.is_empty() => {
                        offset += data.data.len() as u64;
                        hash.update(data.data);
                    }
                    Ok(_) => break,
                    Err(error) if is_eof(&error) => break,
                    Err(error) => return Err(error.into()),
                }
            }
            Ok(format!("{:x}", hash.finalize()))
        }
        .await;
        let close = self.sftp.close(handle).await;
        let result = result?;
        close?;
        Ok(result)
    }
    async fn upload(
        &self,
        local: &Path,
        folder: &str,
        overwrite: bool,
        cancel: &AtomicBool,
        events: &Channel<TransferProgress>,
        id: &str,
        completed: &mut u64,
        total: u64,
    ) -> Result<()> {
        let name = local
            .file_name()
            .and_then(|name| name.to_str())
            .context("SSH_INVALID_NAME")?;
        relative(name)?;
        let folder = self.resolve(folder, true).await?;
        if !self.sftp.stat(&folder).await?.attrs.is_dir() {
            bail!("SSH_INVALID_ROOT");
        }
        let destination = join(&folder, name);
        let old = self.exists(&destination).await?;
        let version = if let Some(attrs) = &old {
            if !overwrite {
                bail!("SSH_DESTINATION_EXISTS");
            }
            if !attrs.is_regular() || attrs.is_symlink() {
                bail!("SSH_REGULAR_FILE_REQUIRED");
            }
            if !self.replace {
                bail!("SSH_SAFE_REPLACE_UNSUPPORTED");
            }
            Some(self.remote_digest(&destination, cancel).await?)
        } else {
            None
        };
        let before = tokio::fs::symlink_metadata(local).await?;
        if !before.is_file() || before.file_type().is_symlink() {
            bail!("SSH_REGULAR_FILE_REQUIRED");
        }
        let mut file = tokio::fs::File::open(local).await?;
        let temporary = join(&folder, &format!(".uterm-upload-{}", uuid::Uuid::new_v4()));
        let handle = self
            .sftp
            .open(
                &temporary,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes {
                    permissions: Some(0o600),
                    ..Default::default()
                },
            )
            .await?
            .handle;
        let result = async {
            let mut bytes = vec![0; CHUNK];
            let mut offset = 0;
            let mut source_hash = Sha256::new();
            loop {
                cancelled(cancel)?;
                let count = file.read(&mut bytes).await?;
                if count == 0 {
                    break;
                }
                self.sftp
                    .write(&handle, offset, bytes[..count].to_vec())
                    .await?;
                source_hash.update(&bytes[..count]);
                offset += count as u64;
                *completed += count as u64;
                progress(events, id, name, *completed, total)?;
            }
            let after = file.metadata().await?;
            if offset != before.len()
                || before.len() != after.len()
                || before.modified()? != after.modified()?
                || local_version(local.to_owned()).await?
                    != Some(format!("{:x}", source_hash.finalize()))
            {
                bail!("SSH_SOURCE_CHANGED");
            }
            if let Some(attrs) = &old {
                self.sftp
                    .fsetstat(
                        &handle,
                        FileAttributes {
                            permissions: attrs.permissions.map(|value| value & 0o777),
                            ..Default::default()
                        },
                    )
                    .await?;
            }
            if self.fsync {
                self.sftp.fsync(&handle).await?;
            }
            self.sftp.close(&handle).await?;
            cancelled(cancel)?;
            if self
                .resolve(
                    folder
                        .strip_prefix(&self.root.path)
                        .unwrap_or("")
                        .trim_start_matches('/'),
                    true,
                )
                .await?
                != folder
            {
                bail!("SSH_TARGET_CHANGED");
            }
            match version {
                Some(ref version) => {
                    if self
                        .exists(&destination)
                        .await?
                        .is_none_or(|attrs| attrs.is_symlink() || !attrs.is_regular())
                        || self.remote_digest(&destination, cancel).await? != *version
                    {
                        bail!("SSH_TARGET_CHANGED");
                    }
                    self.replace_temp(&temporary, &destination).await?;
                }
                None => {
                    if self.exists(&destination).await?.is_some() {
                        bail!("SSH_DESTINATION_EXISTS");
                    }
                    self.sftp.rename(&temporary, &destination).await?;
                }
            }
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = self.sftp.close(handle).await;
            let _ = self.sftp.remove(&temporary).await;
        }
        result
    }
    async fn download(
        &self,
        path: &str,
        local: PathBuf,
        cancel: &AtomicBool,
        events: &Channel<TransferProgress>,
        id: &str,
    ) -> Result<()> {
        let source = self.resolve(path, true).await?;
        let old_local = local_version(local.clone()).await?;
        let parent = local.parent().context("SSH_INVALID_ROOT")?.canonicalize()?;
        let name = local.file_name().context("SSH_INVALID_NAME")?;
        let destination = parent.join(name);
        let temporary = tempfile::Builder::new()
            .prefix(".uterm-download-")
            .tempfile_in(&parent)?;
        let mut file = tokio::fs::File::from_std(temporary.reopen()?);
        let handle = self
            .sftp
            .open(&source, OpenFlags::READ, FileAttributes::default())
            .await?
            .handle;
        let result = async {
            let attrs = self.sftp.fstat(&handle).await?.attrs;
            if !attrs.is_regular() {
                bail!("SSH_REGULAR_FILE_REQUIRED");
            }
            let total = attrs.size.unwrap_or(0);
            let mut offset = 0;
            let mut source_hash = Sha256::new();
            loop {
                cancelled(cancel)?;
                match self.sftp.read(&handle, offset, CHUNK as u32).await {
                    Ok(data) if !data.data.is_empty() => {
                        file.write_all(&data.data).await?;
                        source_hash.update(&data.data);
                        offset += data.data.len() as u64;
                        progress(events, id, path, offset, total)?;
                    }
                    Ok(_) => break,
                    Err(error) if is_eof(&error) => break,
                    Err(error) => return Err(error.into()),
                }
            }
            let after = self.sftp.fstat(&handle).await?.attrs;
            if attrs.size != after.size
                || attrs.mtime != after.mtime
                || attrs.size.is_some_and(|size| size != offset)
                || self.resolve(path, true).await? != source
                || self.remote_digest(&source, cancel).await?
                    != format!("{:x}", source_hash.finalize())
            {
                bail!("SSH_SOURCE_CHANGED");
            }
            file.flush().await?;
            file.sync_all().await?;
            drop(file);
            cancelled(cancel)?;
            let before = local_version(destination.clone()).await?;
            if before != old_local {
                bail!("SSH_TARGET_CHANGED");
            }
            tauri::async_runtime::spawn_blocking(move || {
                if old_local.is_some() {
                    temporary
                        .persist(destination)
                        .map_err(|error| error.error)?;
                } else {
                    temporary
                        .persist_noclobber(destination)
                        .map_err(|error| error.error)?;
                }
                Ok::<_, anyhow::Error>(())
            })
            .await??;
            Ok(())
        }
        .await;
        let close = self.sftp.close(handle).await;
        result?;
        close?;
        Ok(())
    }
}
async fn local_version(path: PathBuf) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            bail!("SSH_REGULAR_FILE_REQUIRED");
        }
        let mut file = std::fs::File::open(path)?;
        let mut hash = Sha256::new();
        let mut bytes = vec![0; CHUNK];
        loop {
            let count = file.read(&mut bytes)?;
            if count == 0 {
                break;
            }
            hash.update(&bytes[..count]);
        }
        Ok(Some(format!("{:x}", hash.finalize())))
    })
    .await?
}
#[tauri::command]
pub async fn ssh_transfer(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SshFiles>,
    root: RemoteRoot,
    path: String,
    direction: String,
    id: String,
    overwrite: bool,
    events: Channel<TransferProgress>,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err("SSH_INVALID_ACTION".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut tasks = state.transfers.lock().map_err(failure)?;
        if tasks.contains_key(&id) || tasks.len() >= 4 {
            return Err("SSH_TRANSFER_BUSY".into());
        }
        tasks.insert(id.clone(), cancel.clone());
    }
    let _guard = TransferGuard {
        state: &state,
        id: id.clone(),
    };
    async {
        let paths = tauri::async_runtime::spawn_blocking(move || {
            let dialog = window.dialog().file().set_parent(&window);
            let selected = if direction == "upload" {
                dialog.blocking_pick_files()
            } else if direction == "download" {
                dialog
                    .set_file_name(path.rsplit('/').next().unwrap_or("download"))
                    .blocking_save_file()
                    .map(|path| vec![path])
            } else {
                return Err(anyhow!("SSH_INVALID_ACTION"));
            };
            Ok::<_, anyhow::Error>((
                selected
                    .map(|paths| {
                        paths
                            .into_iter()
                            .map(|path| path.into_path().map_err(|error| anyhow!("{error}")))
                            .collect::<Result<Vec<_>>>()
                    })
                    .transpose()?,
                direction,
                path,
            ))
        })
        .await??;
        let (Some(paths), direction, path) = paths else {
            bail!("SSH_TRANSFER_CANCELLED");
        };
        cancelled(&cancel)?;
        let remote = remote(&state, &root).await?;
        let _write = remote.writes.lock().await;
        if direction == "upload" {
            let mut total = 0u64;
            for path in &paths {
                let metadata = tokio::fs::symlink_metadata(path).await?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    bail!("SSH_REGULAR_FILE_REQUIRED");
                }
                total = total
                    .checked_add(metadata.len())
                    .context("SSH_FILE_TOO_LARGE")?;
            }
            let mut completed = 0;
            for local in paths {
                cancelled(&cancel)?;
                remote
                    .upload(
                        &local,
                        &path,
                        overwrite,
                        &cancel,
                        &events,
                        &id,
                        &mut completed,
                        total,
                    )
                    .await?;
            }
        } else {
            remote
                .download(
                    &path,
                    paths.into_iter().next().context("SSH_INVALID_ACTION")?,
                    &cancel,
                    &events,
                    &id,
                )
                .await?;
        }
        Ok::<_, anyhow::Error>(())
    }
    .await
    .map_err(failure)
}
#[tauri::command]
pub fn ssh_transfer_cancel(state: tauri::State<'_, SshFiles>, id: String) -> Result<(), String> {
    if let Some(cancel) = state.transfers.lock().map_err(failure)?.get(&id) {
        cancel.store(true, Ordering::Release);
    }
    Ok(())
}
#[tauri::command]
pub async fn ssh_transfer_cancel_all(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshFiles>,
    exit: bool,
) -> Result<(), String> {
    state.cancel_all();
    tokio::time::timeout(Duration::from_secs(60), async {
        while state.busy() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| "SSH_TRANSFER_BUSY")?;
    state.roots.lock().await.clear();
    if exit {
        app.exit(0);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_paths_use_server_rules_and_component_boundaries() {
        assert_eq!(canonical("/srv/app/", false).unwrap(), "/srv/app");
        assert_eq!(canonical("c:\\Users\\测试", true).unwrap(), "C:/Users/测试");
        assert_eq!(canonical("/c:/data/", true).unwrap(), "C:/data");
        for path in ["\\\\server\\share", "C:relative", "/", "C:/a/../b"] {
            assert!(canonical(path, true).is_err());
        }
        for path in [
            "../escape",
            "/etc/passwd",
            "x/../y",
            "C:/x",
            "x\\y",
            "x\0",
            "x//y",
        ] {
            assert!(relative(path).is_err());
        }
        assert!(within("C:/data", "C:/data/file"));
        assert!(!within("C:/data", "C:/database/file"));
        assert!(!within("/data", "/data-other"));
    }
    #[test]
    fn alias_discovery_does_not_execute_match_rules_and_stops_include_cycles() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config");
        let included = directory.path().join("included");
        std::fs::write(
            &config,
            format!(
                "Host prod lab *.wild !excluded\n Match exec touch-never-run\n Include {}\n",
                included.display()
            ),
        )
        .unwrap();
        std::fs::write(
            &included,
            format!("Host jump\n Include {}\n", config.display()),
        )
        .unwrap();
        let mut values = HashSet::new();
        aliases(&config, &mut HashSet::new(), &mut values, 0);
        assert_eq!(
            values,
            ["prod", "lab", "jump"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        );
    }
    #[cfg(unix)]
    async fn fixture(path: &Path) -> Arc<RemoteFs> {
        let program = ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server"]
            .into_iter()
            .find(|path| Path::new(path).is_file())
            .expect("OpenSSH sftp-server test fixture");
        let mut command = Command::new(program);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = BackgroundChild::spawn(&mut command).unwrap();
        let stream = tokio::io::join(
            pipe_file(child.take_stdout().unwrap()),
            pipe_file(child.take_stdin().unwrap()),
        );
        let sftp = RawSftpSession::new(stream);
        sftp.set_timeout(5);
        let version = sftp.init().await.unwrap();
        let path = path.canonicalize().unwrap().to_str().unwrap().to_owned();
        Arc::new(RemoteFs {
            root: RemoteRoot {
                connection: SshTarget {
                    connection_id: "test".into(),
                    workspace_id: "local".into(),
                    name: "Fixture".into(),
                    host: "fixture".into(),
                    os: "posix".into(),
                    root: path.clone(),
                },
                path,
                identity: "0".repeat(64),
            },
            sftp,
            replace: version.extensions.contains_key("posix-rename@openssh.com"),
            fsync: version.extensions.contains_key("fsync@openssh.com"),
            child: Mutex::new(child),
            stderr: Arc::new(Mutex::new(vec![])),
            writes: AsyncMutex::new(()),
        })
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn real_sftp_saves_detect_conflicts_reject_links_and_keep_originals() {
        let directory = tempfile::tempdir().unwrap();
        let remote = fixture(directory.path()).await;
        let file = directory.path().join("中文 file.txt");
        std::fs::write(&file, "before\r\n").unwrap();
        let expected = digest(b"before\r\n");
        assert_eq!(
            remote
                .save("中文 file.txt", "after\r\n", &expected, false)
                .await
                .unwrap(),
            digest(b"after\r\n")
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"after\r\n");
        assert!(remote
            .save("中文 file.txt", "bad", &expected, false)
            .await
            .unwrap_err()
            .to_string()
            .starts_with("CONFLICT:"));
        assert_eq!(std::fs::read(&file).unwrap(), b"after\r\n");
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("escape")).unwrap();
        assert!(remote.resolve("escape/secret", false).await.is_err());
        std::os::unix::fs::symlink(&file, directory.path().join("inside")).unwrap();
        assert!(remote.resolve("inside", false).await.is_ok());
        assert!(remote.resolve("inside", true).await.is_err());
        assert!(!std::fs::read_dir(directory.path())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".uterm-")));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn real_sftp_transfers_stream_cancel_and_reject_unconfirmed_overwrites() {
        let directory = tempfile::tempdir().unwrap();
        let remote = fixture(directory.path()).await;
        let source = tempfile::tempdir().unwrap();
        let file = source.path().join("large.bin");
        let bytes: Vec<_> = (0..(CHUNK * 5 + 17))
            .map(|index| (index % 256) as u8)
            .collect();
        std::fs::write(&file, &bytes).unwrap();
        let cancel = AtomicBool::new(false);
        let events = Channel::new(|_| Ok(()));
        let mut completed = 0;
        remote
            .upload(
                &file,
                "",
                false,
                &cancel,
                &events,
                "test",
                &mut completed,
                bytes.len() as u64,
            )
            .await
            .unwrap();
        assert_eq!(completed, bytes.len() as u64);
        assert_eq!(
            std::fs::read(directory.path().join("large.bin")).unwrap(),
            bytes
        );
        assert!(remote
            .upload(
                &file,
                "",
                false,
                &cancel,
                &events,
                "test",
                &mut completed,
                0
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("SSH_DESTINATION_EXISTS"));
        let download = source.path().join("download.bin");
        remote
            .download("large.bin", download.clone(), &cancel, &events, "test")
            .await
            .unwrap();
        assert_eq!(std::fs::read(download).unwrap(), bytes);
        let flag = Arc::new(AtomicBool::new(false));
        let trigger = flag.clone();
        let events = Channel::new(move |_| {
            trigger.store(true, Ordering::Release);
            Ok(())
        });
        assert!(remote
            .upload(&file, "", true, &flag, &events, "test", &mut completed, 0)
            .await
            .is_err());
        assert_eq!(
            std::fs::read(directory.path().join("large.bin")).unwrap(),
            bytes
        );
        assert!(!std::fs::read_dir(directory.path())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".uterm-")));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn real_sftp_file_management_rejects_overwrite_root_delete_and_nonempty_delete() {
        let directory = tempfile::tempdir().unwrap();
        let remote = fixture(directory.path()).await;
        remote
            .mutate("".into(), "directory".into(), "folder".into())
            .await
            .unwrap();
        remote
            .mutate("folder".into(), "file".into(), "测试.txt".into())
            .await
            .unwrap();
        assert!(remote
            .mutate("folder".into(), "delete".into(), "".into())
            .await
            .is_err());
        assert!(remote
            .mutate("".into(), "delete".into(), "".into())
            .await
            .is_err());
        assert!(remote
            .mutate("folder".into(), "file".into(), "测试.txt".into())
            .await
            .is_err());
        assert!(remote
            .mutate("folder".into(), "file".into(), "../outside".into())
            .await
            .is_err());
        remote
            .mutate(
                "folder/测试.txt".into(),
                "rename".into(),
                "renamed.txt".into(),
            )
            .await
            .unwrap();
        assert!(directory.path().join("folder/renamed.txt").is_file());
        remote
            .mutate("folder/renamed.txt".into(), "delete".into(), "".into())
            .await
            .unwrap();
        remote
            .mutate("folder".into(), "delete".into(), "".into())
            .await
            .unwrap();
        assert!(!directory.path().join("folder").exists());
        std::fs::write(directory.path().join("original"), b"untouched").unwrap();
        let mut no_replace = Arc::try_unwrap(remote).ok().expect("exclusive fixture");
        no_replace.replace = false;
        assert!(no_replace
            .save("original", "changed", &digest(b"untouched"), true)
            .await
            .unwrap_err()
            .to_string()
            .contains("SSH_SAFE_REPLACE_UNSUPPORTED"));
        assert_eq!(
            std::fs::read(directory.path().join("original")).unwrap(),
            b"untouched"
        );
    }
}
