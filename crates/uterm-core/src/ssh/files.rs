use super::paths::{canonical, join, relative, within};
use anyhow::{anyhow, bail, Context, Result};
use russh_sftp::{
    client::{error::Error as SftpError, rawsession::RawSftpSession},
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::process::{Command, Stdio};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex as AsyncMutex,
};
use utermd_local::{ssh::SshTarget, BackgroundChild};

const CHUNK: usize = 32 * 1024;
const PREVIEW_LIMIT: usize = 8 * 1024 * 1024;
const TEXT_LIMIT: usize = 2 * 1024 * 1024;
type OwnedChild = Arc<Mutex<Option<BackgroundChild>>>;

#[derive(Default)]
pub struct SshFiles {
    roots: AsyncMutex<HashMap<String, Arc<RemoteFs>>>,
    transfers: Arc<Mutex<HashMap<String, (uuid::Uuid, Arc<AtomicBool>)>>>,
    closing: AtomicBool,
    stopped: AtomicBool,
    children: Mutex<Vec<Weak<Mutex<Option<BackgroundChild>>>>>,
}
struct Closing<'a>(&'a AtomicBool);
impl Drop for Closing<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl SshFiles {
    fn spawn_owned(&self, command: &mut std::process::Command) -> Result<OwnedChild> {
        let mut children = self.children.lock().map_err(|_| anyhow!("SSH_CLOSED"))?;
        if self.stopped.load(Ordering::Acquire) {
            bail!("SSH_CLOSED");
        }
        let child = Arc::new(Mutex::new(Some(BackgroundChild::spawn(command)?)));
        children.retain(|child| child.strong_count() > 0);
        children.push(Arc::downgrade(&child));
        Ok(child)
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.cancel_all();
        if let Ok(mut children) = self.children.lock() {
            for child in children.drain(..).filter_map(|child| child.upgrade()) {
                if let Ok(mut child) = child.lock() {
                    child.take();
                }
            }
        }
    }
    pub fn busy(&self) -> bool {
        self.transfers
            .lock()
            .map_or(true, |tasks| !tasks.is_empty())
    }
    pub fn cancel_all(&self) {
        if let Ok(tasks) = self.transfers.lock() {
            for (_, task) in tasks.values() {
                task.store(true, Ordering::Release);
            }
        }
    }
}
impl Drop for SshFiles {
    fn drop(&mut self) {
        self.stop();
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
    child: OwnedChild,
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

use super::{base_command, pipe_file};

impl RemoteFs {
    async fn connect(
        owner: &SshFiles,
        connection: SshTarget,
        expected: Option<&RemoteRoot>,
        prepared: super::auth::Prepared,
    ) -> Result<Arc<Self>> {
        connection.validate()?;
        let effective = &prepared.effective;
        if expected.is_some_and(|root| root.identity != effective.identity) {
            bail!("SSH_TARGET_CHANGED");
        }
        let mut command = base_command()?;
        command.args(connection.options());
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
        let child = owner.spawn_owned(&mut command)?;
        let (stream, mut errors) = {
            let mut guard = child.lock().map_err(|_| anyhow!("SSH_DISCONNECTED"))?;
            let child = guard.as_mut().context("SSH_DISCONNECTED")?;
            (
                tokio::io::join(
                    pipe_file(child.take_stdout().context("SSH_PIPE_FAILED")?),
                    pipe_file(child.take_stdin().context("SSH_PIPE_FAILED")?),
                ),
                pipe_file(child.take_stderr().context("SSH_PIPE_FAILED")?),
            )
        };
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
        sftp.set_timeout(if prepared.askpass.is_some() { 120 } else { 15 });
        let version = sftp.init().await.map_err(|error| {
            anyhow!(
                "SSH_SFTP_FAILED: {error}: {}",
                stderr
                    .lock()
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .unwrap_or_default()
            )
        })?;
        sftp.set_timeout(15);
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
                identity: effective.identity.clone(),
            },
            sftp,
            replace: version.extensions.contains_key("posix-rename@openssh.com"),
            fsync: version.extensions.contains_key("fsync@openssh.com"),
            child,
            stderr,
            writes: AsyncMutex::new(()),
        }))
    }
    fn alive(&self) -> Result<()> {
        if self
            .child
            .lock()
            .map_err(|_| anyhow!("SSH_DISCONNECTED"))?
            .as_mut()
            .context("SSH_DISCONNECTED")?
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
    let remote = state
        .roots
        .lock()
        .await
        .get(&root.key()?)
        .cloned()
        .context("SSH_DISCONNECTED")?;
    remote.alive()?;
    Ok(remote)
}
impl SshFiles {
    pub(crate) async fn connected(&self, connection_id: &str) -> bool {
        self.roots
            .lock()
            .await
            .values()
            .any(|v| v.root.connection.connection_id == connection_id)
    }
    pub async fn contains(&self, root: &RemoteRoot) -> Result<bool> {
        root.validate()?;
        Ok(self.roots.lock().await.contains_key(&root.key()?))
    }
    pub async fn open(
        &self,
        connection: SshTarget,
        expected: Option<RemoteRoot>,
        prepared: super::auth::Prepared,
    ) -> Result<RemoteRoot> {
        if self.stopped.load(Ordering::Acquire) {
            bail!("SSH_CLOSED");
        }
        if self.closing.load(Ordering::Acquire) {
            bail!("SSH_TRANSFER_BUSY");
        }
        let mut roots = self.roots.lock().await;
        let remote = RemoteFs::connect(self, connection, expected.as_ref(), prepared).await?;
        let root = remote.root.clone();
        let key = root.key()?;
        if roots.len() >= 16 && !roots.contains_key(&key) {
            bail!("SSH_CONNECTION_LIMIT");
        }
        roots.insert(key, remote);
        Ok(root)
    }
    pub async fn disconnect(&self, connection_id: &str) -> Result<()> {
        if self.busy() {
            bail!("SSH_TRANSFER_BUSY");
        }
        self.roots
            .lock()
            .await
            .retain(|_, remote| remote.root.connection.connection_id != connection_id);
        Ok(())
    }
    pub async fn cancel_and_disconnect(&self) -> Result<()> {
        if self.closing.swap(true, Ordering::AcqRel) {
            bail!("SSH_TRANSFER_BUSY");
        }
        let _closing = Closing(&self.closing);
        self.cancel_all();
        let result = tokio::time::timeout(Duration::from_secs(60), async {
            while self.busy() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .context("SSH_TRANSFER_BUSY");
        if result.is_ok() {
            self.roots.lock().await.clear();
        }
        result
    }
}
#[derive(Serialize)]
pub struct RemoteEntry {
    pub path: String,
    pub name: String,
    pub directory: bool,
    pub symlink: bool,
}
#[derive(Serialize)]
pub struct RemoteListing {
    pub entries: Vec<RemoteEntry>,
    pub partial: bool,
    pub skipped: usize,
}
pub async fn ssh_files_list(
    state: &SshFiles,
    root: RemoteRoot,
    path: String,
    hidden: bool,
) -> Result<RemoteListing, String> {
    async {
        let remote = remote(state, &root).await?;
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
pub async fn ssh_file_read(
    state: &SshFiles,
    root: RemoteRoot,
    path: String,
) -> Result<crate::files::FileDocument, String> {
    let remote = remote(state, &root).await.map_err(failure)?;
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
pub async fn ssh_file_save(
    state: &SshFiles,
    root: RemoteRoot,
    path: String,
    text: String,
    expected: String,
    force: bool,
) -> Result<String, String> {
    remote(state, &root)
        .await
        .map_err(failure)?
        .save(&path, &text, &expected, force)
        .await
        .map_err(failure)
}
impl RemoteFs {
    async fn delete_tree(&self, path: &str) -> Result<()> {
        let target = join(&self.root.path, path);
        let attrs = self.sftp.lstat(&target).await?.attrs;
        // Unlink nested links themselves; never traverse their targets.
        // 只删除目录内的链接本身，绝不遍历其指向的目标。
        if attrs.is_symlink() || !attrs.is_dir() {
            self.sftp.remove(target).await?;
            return Ok(());
        }
        let target = self.resolve(path, true).await?;
        let handle = self.sftp.opendir(&target).await?.handle;
        let result: Result<()> = async {
            loop {
                let packet = match self.sftp.readdir(&handle).await {
                    Ok(packet) => packet,
                    Err(error) if is_eof(&error) => break,
                    Err(error) => return Err(error.into()),
                };
                for item in packet.files {
                    if item.filename == "." || item.filename == ".." {
                        continue;
                    }
                    relative(&item.filename)?;
                    if item.filename.is_empty() || item.filename.contains('/') {
                        bail!("SSH_INVALID_NAME");
                    }
                    Box::pin(self.delete_tree(&join(path, &item.filename))).await?;
                }
            }
            Ok(())
        }
        .await;
        let close = self.sftp.close(handle).await;
        result?;
        close?;
        self.sftp.rmdir(target).await?;
        Ok(())
    }
    async fn mutate(&self, path: String, action: String, name: String) -> Result<()> {
        let remote = self;
        let _guard = remote.writes.lock().await;
        let target = remote.resolve(&path, true).await?;
        if action == "delete" {
            if path.is_empty() || target == remote.root.path {
                bail!("SSH_PATH_OUTSIDE_ROOT");
            }
            return remote.delete_tree(&path).await;
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
pub async fn ssh_file_mutate(
    state: &SshFiles,
    root: RemoteRoot,
    path: String,
    action: String,
    name: String,
) -> Result<(), String> {
    remote(state, &root)
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
pub struct TransferGuard {
    registry: Arc<Mutex<HashMap<String, (uuid::Uuid, Arc<AtomicBool>)>>>,
    id: String,
    cancel: Arc<AtomicBool>,
    pub generation: uuid::Uuid,
}
impl Drop for TransferGuard {
    fn drop(&mut self) {
        if let Ok(mut tasks) = self.registry.lock() {
            if tasks
                .get(&self.id)
                .is_some_and(|(generation, _)| *generation == self.generation)
            {
                tasks.remove(&self.id);
            }
        }
    }
}
fn progress(events: &Progress<'_>, id: &str, name: &str, completed: u64, total: u64) -> Result<()> {
    events(TransferProgress {
        id: id.into(),
        name: name.into(),
        completed,
        total,
        state: "running".into(),
    })
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
        events: &Progress<'_>,
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
        events: &Progress<'_>,
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
            tokio::task::spawn_blocking(move || {
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
    tokio::task::spawn_blocking(move || {
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
pub type Progress<'a> = dyn Fn(TransferProgress) -> Result<()> + Send + Sync + 'a;
impl SshFiles {
    pub fn begin_transfer(&self, id: &str) -> Result<TransferGuard> {
        if uuid::Uuid::parse_str(id).is_err() {
            bail!("SSH_INVALID_ACTION");
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let mut tasks = self
            .transfers
            .lock()
            .map_err(failure)
            .map_err(anyhow::Error::msg)?;
        if self.stopped.load(Ordering::Acquire) {
            bail!("SSH_CLOSED");
        }
        if tasks.contains_key(id) || tasks.len() >= 4 || self.closing.load(Ordering::Acquire) {
            bail!("SSH_TRANSFER_BUSY");
        }
        let generation = uuid::Uuid::new_v4();
        tasks.insert(id.to_owned(), (generation, cancel.clone()));
        Ok(TransferGuard {
            registry: self.transfers.clone(),
            id: id.to_owned(),
            cancel,
            generation,
        })
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        self.cancel_generation(id, None)
    }
    pub fn cancel_generation(&self, id: &str, generation: Option<uuid::Uuid>) -> Result<()> {
        if let Some((current, cancel)) = self
            .transfers
            .lock()
            .map_err(failure)
            .map_err(anyhow::Error::msg)?
            .get(id)
        {
            if generation.is_some_and(|expected| expected != *current) {
                bail!("SSH_TRANSFER_CHANGED");
            }
            cancel.store(true, Ordering::Release);
        }
        Ok(())
    }
    pub async fn transfer(
        &self,
        root: &RemoteRoot,
        path: &str,
        direction: &str,
        paths: Vec<PathBuf>,
        overwrite: bool,
        task: &TransferGuard,
        events: &Progress<'_>,
    ) -> Result<()> {
        if !Arc::ptr_eq(&task.registry, &self.transfers) {
            bail!("SSH_INVALID_ACTION");
        }
        cancelled(&task.cancel)?;
        let remote = remote(self, root).await?;
        let _write = remote.writes.lock().await;
        match direction {
            "upload" => {
                if paths.is_empty() {
                    bail!("SSH_TRANSFER_CANCELLED");
                }
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
                    cancelled(&task.cancel)?;
                    remote
                        .upload(
                            &local,
                            path,
                            overwrite,
                            &task.cancel,
                            events,
                            &task.id,
                            &mut completed,
                            total,
                        )
                        .await?;
                }
            }
            "download" if paths.len() == 1 => {
                remote
                    .download(
                        path,
                        paths.into_iter().next().context("SSH_INVALID_ACTION")?,
                        &task.cancel,
                        events,
                        &task.id,
                    )
                    .await?
            }
            _ => bail!("SSH_INVALID_ACTION"),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stopping_owned_processes_ignores_other_clients_and_rejects_late_spawns() {
        fn command() -> Command {
            #[cfg(unix)]
            let mut command = {
                let mut command = Command::new("sh");
                command.args(["-c", "exec cat"]);
                command
            };
            #[cfg(windows)]
            let mut command = {
                let mut command = Command::new(
                    PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                        .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
                );
                command.args(["-NoProfile", "-Command", "Start-Sleep 60"]);
                command
            };
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            command
        }
        let first = SshFiles::default();
        let second = SshFiles::default();
        let held = first.spawn_owned(&mut command()).unwrap();
        let sibling = second.spawn_owned(&mut command()).unwrap();
        first.stop();
        first.stop();
        assert!(held.lock().unwrap().is_none());
        assert!(sibling
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none());
        assert!(first.spawn_owned(&mut command()).is_err());
        assert!(first
            .begin_transfer(&uuid::Uuid::new_v4().to_string())
            .is_err());
        second.stop();
        assert!(sibling.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn stale_cancellation_and_cancelled_quit_cannot_affect_a_new_transfer() {
        let state = SshFiles::default();
        let id = uuid::Uuid::new_v4().to_string();
        let old = state.begin_transfer(&id).unwrap();
        let generation = old.generation;
        assert!(state.begin_transfer(&id).is_err());
        drop(old);
        let current = state.begin_transfer(&id).unwrap();
        assert_eq!(
            state
                .cancel_generation(&id, Some(generation))
                .unwrap_err()
                .to_string(),
            "SSH_TRANSFER_CHANGED"
        );
        assert!(!current.cancel.load(Ordering::Acquire));
        {
            let close = state.cancel_and_disconnect();
            tokio::pin!(close);
            tokio::select! {
                _ = close.as_mut() => panic!("Quit must wait for the active transfer"),
                _ = tokio::time::sleep(Duration::from_millis(20)) => {}
            }
            assert!(current.cancel.load(Ordering::Acquire));
            assert!(state
                .begin_transfer(&uuid::Uuid::new_v4().to_string())
                .is_err());
        }
        drop(current);
        assert!(!state.busy());
        let next = state.begin_transfer(&id).unwrap();
        assert!(!next.cancel.load(Ordering::Acquire));
        drop(next);
        state.cancel_and_disconnect().await.unwrap();
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
                    ..Default::default()
                },
                path,
                identity: "0".repeat(64),
            },
            sftp,
            replace: version.extensions.contains_key("posix-rename@openssh.com"),
            fsync: version.extensions.contains_key("fsync@openssh.com"),
            child: Arc::new(Mutex::new(Some(child))),
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
        let events = |_| Ok(());
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
        let events = move |_| {
            trigger.store(true, Ordering::Release);
            Ok(())
        };
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
    async fn real_sftp_file_management_rejects_overwrite_and_root_delete() {
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
    #[cfg(unix)]
    #[tokio::test]
    async fn real_sftp_recursive_delete_includes_unlisted_files_and_does_not_follow_links() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("folder/子目录/empty")).unwrap();
        std::fs::write(directory.path().join("folder/子目录/测试.txt"), "nested").unwrap();
        std::fs::write(directory.path().join("folder/.hidden"), "hidden").unwrap();
        std::fs::write(directory.path().join("keep.txt"), "inside").unwrap();
        std::fs::write(outside.path().join("keep.txt"), "outside").unwrap();
        for index in 0..2100 {
            std::fs::write(directory.path().join(format!("folder/{index}.txt")), "file").unwrap();
        }
        symlink(outside.path(), directory.path().join("folder/outside")).unwrap();
        symlink(directory.path(), directory.path().join("folder/cycle")).unwrap();
        symlink(
            outside.path().join("missing"),
            directory.path().join("folder/broken"),
        )
        .unwrap();
        symlink(
            directory.path().join("keep.txt"),
            directory.path().join("link"),
        )
        .unwrap();
        let remote = fixture(directory.path()).await;
        for path in [
            "",
            ".",
            "..",
            "folder/..",
            "/",
            "link",
            "folder/outside/keep.txt",
        ] {
            assert!(remote
                .mutate(path.into(), "delete".into(), "".into())
                .await
                .is_err());
        }
        remote
            .mutate("folder".into(), "delete".into(), "".into())
            .await
            .unwrap();
        assert!(!directory.path().join("folder").exists());
        assert_eq!(
            std::fs::read(directory.path().join("keep.txt")).unwrap(),
            b"inside"
        );
        assert_eq!(
            std::fs::read(outside.path().join("keep.txt")).unwrap(),
            b"outside"
        );
        assert!(remote
            .mutate("folder".into(), "delete".into(), "".into())
            .await
            .is_err());
    }
}
