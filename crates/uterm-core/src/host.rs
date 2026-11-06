use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use utermd_local::daemon::{Client, HostStatus, Operation, Reply};
pub fn project_directory(directory: String) -> Result<String, String> {
    let path = std::path::Path::new(&directory);
    if !path.is_absolute() || !path.is_dir() {
        return Err("请输入已存在目录的绝对路径。".into());
    }
    path.canonicalize()
        .map_err(|e| e.to_string())?
        .into_os_string()
        .into_string()
        .map_err(|_| "目录名称无法转换为文本。".into())
}
pub struct HostBroker {
    root: PathBuf,
    source: PathBuf,
    executable: OnceLock<PathBuf>,
    lifecycle: Mutex<()>,
}
impl HostBroker {
    pub fn helper_source(&self) -> &std::path::Path {
        &self.source
    }
    pub fn new(root: PathBuf, source: PathBuf) -> Self {
        Self {
            root,
            source,
            executable: OnceLock::new(),
            lifecycle: Mutex::new(()),
        }
    }
    pub fn client(&self) -> Result<Client, String> {
        let _guard = self.lifecycle.lock().map_err(|error| error.to_string())?;
        let root = &self.root;
        let executable = if let Some(path) = self.executable.get() {
            path.clone()
        } else {
            let path = stage_host(root, &self.source)?;
            let _ = self.executable.set(path.clone());
            path
        };
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
            if sessions.iter().any(|session| session.running)
                || same_executable(&running_executable, &executable)
            {
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
            wait_for_shutdown(root, Duration::from_secs(5))?;
        }
        utermd_local::daemon::ensure_running(&root, &executable)
            .map_err(|error| format!("{error:#}"))
    }
}

fn wait_for_shutdown(root: &std::path::Path, timeout: Duration) -> Result<(), String> {
    let ownership = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("host.lock"))
        .map_err(|error| error.to_string())?;
    wait_for_shutdown_lock(root, ownership, timeout)
}

fn wait_for_shutdown_lock(
    root: &std::path::Path,
    ownership: std::fs::File,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if !root.join("endpoint.json").exists() {
            // Endpoint removal precedes the old process dropping its OS lock; wait for both.
            // 旧进程先移除端点再释放系统锁，必须等待两者都完成。
            match ownership.try_lock() {
                Ok(()) => {
                    // Explicit unlock also releases duplicates inherited by a concurrent PTY fork.
                    // 显式解锁也释放并发 PTY fork 继承的重复描述符上的锁。
                    ownership.unlock().map_err(|error| error.to_string())?;
                    return Ok(());
                }
                Err(std::fs::TryLockError::WouldBlock) => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err("后台尚未退出，请稍后重试。".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn same_executable(left: &std::path::Path, right: &std::path::Path) -> bool {
    // Windows reports normal drive paths while canonical app-data paths use a verbatim prefix.
    // Windows 报告普通盘符路径，而规范应用数据路径带扩展前缀；按实际文件身份比较。
    left == right
        || match (left.canonicalize(), right.canonicalize()) {
            (Ok(left), Ok(right)) => left == right,
            _ => false,
        }
}

// Installers may replace or terminate the app executable. Keep the host and its
// agent reporter outside the installation directory, under a content identity.
// 安装器可能替换或结束应用程序；将宿主及 Agent 报告程序按内容哈希存放在安装目录外。
pub fn stage_host(
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
mod tests {
    use super::*;
    #[test]
    fn idle_upgrade_waits_for_the_os_lock_after_endpoint_removal() {
        let root = tempfile::tempdir().unwrap();
        let owner = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(root.path().join("host.lock"))
            .unwrap();
        owner.lock().unwrap();
        let path = root.path().to_owned();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            send.send(wait_for_shutdown(&path, Duration::from_secs(2)))
                .unwrap();
        });
        assert!(
            receive.recv_timeout(Duration::from_millis(100)).is_err(),
            "Endpoint absence must not be mistaken for lock release"
        );
        owner.unlock().unwrap();
        assert!(receive
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_ok());
        worker.join().unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn shutdown_wait_does_not_leave_the_probe_lock_on_a_duplicated_descriptor() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("host.lock");
        let ownership = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        let inherited = ownership.try_clone().unwrap();
        wait_for_shutdown_lock(root.path(), ownership, Duration::from_secs(1)).unwrap();
        let next = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        assert!(
            next.try_lock().is_ok(),
            "A duplicate inherited during a concurrent PTY fork must not retain the probe lock"
        );
        drop(inherited);
    }
    #[test]
    fn unavailable_lock_times_out_without_removing_or_stealing_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("host.lock");
        let owner = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        owner.lock().unwrap();
        assert!(wait_for_shutdown(root.path(), Duration::from_millis(10)).is_err());
        let observer = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        assert!(matches!(
            observer.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
    }
}
