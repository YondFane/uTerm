use super::{
    auth::Prepared,
    files::{self, SshFiles},
    tunnels::{Forward, SshTunnels},
};
use serde_json::json;
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use utermd_local::{ssh::SshTarget, BackgroundChild};

struct Service {
    directory: tempfile::TempDir,
    target: SshTarget,
    configuration: PathBuf,
    server: Option<BackgroundChild>,
    proxy: Proxy,
    server_port: u16,
}
struct Proxy {
    port: u16,
    sockets: Arc<Mutex<Vec<TcpStream>>>,
    stopped: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Proxy {
    fn new(destination: u16) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let sockets = Arc::new(Mutex::new(Vec::<TcpStream>::new()));
        let stopped = Arc::new(AtomicBool::new(false));
        let connections = sockets.clone();
        let done = stopped.clone();
        let worker = std::thread::spawn(move || {
            let mut workers = vec![];
            while !done.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut incoming, _)) => {
                        let mut outgoing = TcpStream::connect(("127.0.0.1", destination)).unwrap();
                        connections
                            .lock()
                            .unwrap()
                            .extend([incoming.try_clone().unwrap(), outgoing.try_clone().unwrap()]);
                        let mut reverse_in = incoming.try_clone().unwrap();
                        let mut reverse_out = outgoing.try_clone().unwrap();
                        workers.push(std::thread::spawn(move || {
                            let _ = std::io::copy(&mut incoming, &mut outgoing);
                            let _ = outgoing.shutdown(Shutdown::Both);
                        }));
                        workers.push(std::thread::spawn(move || {
                            let _ = std::io::copy(&mut reverse_out, &mut reverse_in);
                            let _ = reverse_in.shutdown(Shutdown::Both);
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("proxy: {error}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            port,
            sockets,
            stopped,
            worker: Some(worker),
        }
    }
    fn cut(&self) {
        for socket in self.sockets.lock().unwrap().drain(..) {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.cut();
        self.worker.take().unwrap().join().unwrap();
    }
}
impl Service {
    fn start() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        for name in ["host", "client", "wrong-host", "host-ca"] {
            assert!(Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(root.join(name))
                .status()
                .unwrap()
                .success());
        }
        let user = Command::new("id").arg("-un").output().unwrap();
        assert!(user.status.success());
        let user = String::from_utf8(user.stdout).unwrap().trim().to_owned();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let server_port = listener.local_addr().unwrap().port();
        drop(listener);
        let public = std::fs::read_to_string(root.join("host.pub")).unwrap();
        std::fs::write(root.join("known_hosts"), format!("qa-test-host {public}")).unwrap();
        std::fs::copy(root.join("client.pub"), root.join("authorized_keys")).unwrap();
        let remote = root.join("remote 中文");
        std::fs::create_dir(&remote).unwrap();
        let proxy = Proxy::new(server_port);
        let port = proxy.port;
        let configuration = root.join("client-config");
        std::fs::write(&configuration, format!("Host qa-service\n HostName 127.0.0.1\n User {user}\n Port {port}\n HostKeyAlias qa-test-host\n IdentityFile \"{}\"\n IdentitiesOnly yes\n UserKnownHostsFile \"{}\"\n GlobalKnownHostsFile /dev/null\n", root.join("client").display(), root.join("known_hosts").display())).unwrap();
        let port = server_port;
        let config = root.join("server-config");
        std::fs::write(&config, format!("ListenAddress 127.0.0.1\nPort {port}\nHostKey {}\nPidFile {}\nAuthorizedKeysFile {}\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers {user}\nLogLevel ERROR\nSubsystem sftp internal-sftp\n", root.join("host").display(), root.join("server.pid").display(), root.join("authorized_keys").display())).unwrap();
        let mut command = Command::new("/usr/sbin/sshd");
        command
            .args(["-D", "-e", "-f"])
            .arg(&config)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(root.join("server.log")).unwrap());
        let mut child = BackgroundChild::spawn(&mut command).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(
                child.try_wait().unwrap().is_none(),
                "sshd failed: {}",
                std::fs::read_to_string(root.join("server.log")).unwrap()
            );
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            assert!(Instant::now() < deadline, "sshd startup timeout");
            std::thread::sleep(Duration::from_millis(20));
        }
        let target = SshTarget {
            connection_id: uuid::Uuid::new_v4().to_string(),
            workspace_id: "local".into(),
            name: "Isolated SSH".into(),
            host: "qa-service".into(),
            os: "posix".into(),
            root: remote.to_string_lossy().into_owned(),
            authentication: Some("key".into()),
            ..Default::default()
        };
        Self {
            directory,
            target,
            configuration,
            server: Some(child),
            proxy,
            server_port,
        }
    }
    fn restart(&mut self) {
        self.server.take();
        let root = self.directory.path();
        let mut command = Command::new("/usr/sbin/sshd");
        command
            .args(["-D", "-e", "-f"])
            .arg(root.join("server-config"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(root.join("server.log"))
                    .unwrap(),
            );
        let mut child = BackgroundChild::spawn(&mut command).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(child.try_wait().unwrap().is_none(), "sshd restart failed");
            if TcpStream::connect(("127.0.0.1", self.server_port)).is_ok() {
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        self.server = Some(child);
    }
    async fn prepared(&self) -> Prepared {
        Prepared {
            effective: super::effective_config(
                &self.target.host,
                vec!["-F".into(), self.configuration.to_str().unwrap().into()],
            )
            .await
            .unwrap(),
            askpass: None,
            configuration: Some(self.configuration.clone()),
        }
    }
}

#[tokio::test]
async fn authenticated_ssh_transfers_reconnect_host_trust_and_tunnel_ownership() {
    let mut fixture = Service::start();
    let files = SshFiles::default();
    let tunnels = SshTunnels::default();
    let source = tempfile::tempdir().unwrap();
    let local = source.path().join("literal 中文 ' file.bin");
    let bytes: Vec<u8> = (0..(32 * 1024 * 6 + 19)).map(|n| (n % 251) as u8).collect();
    std::fs::write(&local, &bytes).unwrap();
    let root = files
        .open(fixture.target.clone(), None, fixture.prepared().await)
        .await
        .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let guard = files.begin_transfer(&id).unwrap();
    assert!(files.busy());
    assert_eq!(
        files
            .disconnect(&fixture.target.connection_id)
            .await
            .unwrap_err()
            .to_string(),
        "SSH_TRANSFER_BUSY"
    );
    files
        .transfer(
            &root,
            "",
            "upload",
            vec![local.clone()],
            false,
            &guard,
            &|_| Ok(()),
        )
        .await
        .unwrap();
    drop(guard);
    assert!(!files.busy());
    let listing = files::ssh_files_list(&files, root.clone(), "".into(), true)
        .await
        .unwrap();
    assert_eq!(
        listing.entries[0].name,
        local.file_name().unwrap().to_str().unwrap()
    );
    let name = &listing.entries[0].path;
    let guard = files.begin_transfer(&id).unwrap();
    let download = source.path().join("download.bin");
    files
        .transfer(
            &root,
            name,
            "download",
            vec![download.clone()],
            false,
            &guard,
            &|_| Ok(()),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(download).unwrap(), bytes);
    drop(guard);
    let guard = files.begin_transfer(&id).unwrap();
    let generation = guard.generation;
    let cancelling = |_: files::TransferProgress| {
        files.cancel_generation(&id, Some(generation)).unwrap();
        Ok(())
    };
    assert_eq!(
        files
            .transfer(
                &root,
                "",
                "upload",
                vec![local.clone()],
                true,
                &guard,
                &cancelling
            )
            .await
            .unwrap_err()
            .to_string(),
        "SSH_TRANSFER_CANCELLED"
    );
    drop(guard);
    assert_eq!(
        std::fs::read(PathBuf::from(&root.path).join(local.file_name().unwrap())).unwrap(),
        bytes
    );
    assert!(!std::fs::read_dir(&root.path).unwrap().any(|p| p
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".uterm-")));
    files
        .disconnect(&fixture.target.connection_id)
        .await
        .unwrap();
    let reopened = files
        .open(
            fixture.target.clone(),
            Some(root.clone()),
            fixture.prepared().await,
        )
        .await
        .unwrap();
    assert_eq!(reopened.identity, root.identity);
    assert_eq!(
        files::ssh_files_list(&files, root.clone(), "".into(), true)
            .await
            .unwrap()
            .entries
            .len(),
        1
    );

    let guard = files.begin_transfer(&id).unwrap();
    let cut = |_: files::TransferProgress| {
        fixture.proxy.cut();
        Ok(())
    };
    assert!(files
        .transfer(&root, "", "upload", vec![local.clone()], true, &guard, &cut)
        .await
        .is_err());
    drop(guard);
    assert!(!files.busy());
    assert_eq!(
        std::fs::read(PathBuf::from(&root.path).join(local.file_name().unwrap())).unwrap(),
        bytes
    );
    files
        .open(
            fixture.target.clone(),
            Some(root.clone()),
            fixture.prepared().await,
        )
        .await
        .unwrap();
    let guard = files.begin_transfer(&id).unwrap();
    files
        .transfer(
            &root,
            "",
            "upload",
            vec![local.clone()],
            true,
            &guard,
            &|_| Ok(()),
        )
        .await
        .unwrap();
    drop(guard);
    for item in std::fs::read_dir(&root.path).unwrap() {
        let item = item.unwrap();
        if item
            .file_name()
            .to_string_lossy()
            .starts_with(".uterm-upload-")
        {
            std::fs::remove_file(item.path()).unwrap();
        }
    }

    let echo = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    echo.set_nonblocking(true).unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let stopped = done.clone();
    let worker = std::thread::spawn(move || {
        while !stopped.load(Ordering::Acquire) {
            match echo.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut bytes = [0; 4];
                    if stream.read_exact(&mut bytes).is_ok() {
                        stream.write_all(&bytes).unwrap();
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(error) => panic!("echo: {error}"),
            }
        }
    });
    let mut statuses = vec![];
    for _ in 0..2 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let local_port = listener.local_addr().unwrap().port();
        drop(listener);
        let rule = Forward {
            id: uuid::Uuid::new_v4().to_string(),
            local_port,
            remote_host: "127.0.0.1".into(),
            remote_port: echo_port,
        };
        let prepared = fixture.prepared().await;
        let status = tunnels
            .start(async move { Ok(prepared) }, fixture.target.clone(), rule)
            .unwrap();
        statuses.push((status, local_port));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let statuses = tunnels.list().await.unwrap();
        assert!(
            !statuses.iter().any(|s| s.state == "error"),
            "tunnel failed: {}",
            serde_json::to_string(&statuses).unwrap()
        );
        if statuses.iter().filter(|s| s.state == "running").count() == 2 {
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let echo_roundtrip = |port| {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream.write_all(b"ping").unwrap();
        let mut bytes = [0; 4];
        stream.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"ping");
    };
    echo_roundtrip(statuses[0].1);
    echo_roundtrip(statuses[1].1);
    assert_eq!(
        tunnels
            .stop_generation(
                fixture.target.connection_id.clone(),
                statuses[0].0.id.clone(),
                Some(uuid::Uuid::new_v4().to_string())
            )
            .await
            .unwrap_err(),
        "SSH_FORWARD_CHANGED"
    );
    tunnels
        .stop_generation(
            fixture.target.connection_id.clone(),
            statuses[0].0.id.clone(),
            Some(statuses[0].0.generation.clone()),
        )
        .await
        .unwrap();
    assert_eq!(tunnels.list().await.unwrap().len(), 1);
    echo_roundtrip(statuses[1].1);
    tunnels.stop();
    done.store(true, Ordering::Release);
    worker.join().unwrap();
    files
        .disconnect(&fixture.target.connection_id)
        .await
        .unwrap();
    let wrong = std::fs::read_to_string(fixture.directory.path().join("wrong-host.pub")).unwrap();
    std::fs::write(
        fixture.directory.path().join("known_hosts"),
        format!("qa-test-host {wrong}"),
    )
    .unwrap();
    let error = files
        .open(fixture.target.clone(), None, fixture.prepared().await)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("SSH_SFTP_FAILED"));
    assert!(
        error
            .to_string()
            .contains("HOST IDENTIFICATION HAS CHANGED")
            || error.to_string().contains("Host key verification failed")
    );
    let ca = fixture.directory.path().join("host-ca");
    let host = fixture.directory.path().join("host.pub");
    assert!(Command::new("ssh-keygen")
        .arg("-q")
        .arg("-s")
        .arg(&ca)
        .args(["-I", "qa-host", "-h", "-n", "qa-test-host"])
        .arg(&host)
        .status()
        .unwrap()
        .success());
    let config_path = fixture.directory.path().join("server-config");
    let mut config = std::fs::read_to_string(&config_path).unwrap();
    config.push_str(&format!(
        "HostCertificate {}\n",
        fixture.directory.path().join("host-cert.pub").display()
    ));
    std::fs::write(config_path, config).unwrap();
    fixture.restart();
    let public_ca = std::fs::read_to_string(fixture.directory.path().join("host-ca.pub")).unwrap();
    std::fs::write(
        fixture.directory.path().join("known_hosts"),
        format!("@cert-authority qa-test-host {public_ca}"),
    )
    .unwrap();
    files
        .open(fixture.target.clone(), None, fixture.prepared().await)
        .await
        .unwrap();
    files
        .disconnect(&fixture.target.connection_id)
        .await
        .unwrap();
    std::fs::write(
        fixture.directory.path().join("known_hosts"),
        format!("@cert-authority qa-test-host {wrong}"),
    )
    .unwrap();
    assert!(files
        .open(fixture.target.clone(), None, fixture.prepared().await)
        .await
        .unwrap_err()
        .to_string()
        .contains("SSH_SFTP_FAILED"));
    fixture.server.take();
    let fixture_path = fixture.directory.path().to_owned();
    drop(fixture);
    assert!(!fixture_path.exists());
    if let Some(path) = std::env::var_os("UTERM_SSH_SERVICE_REPORT") {
        let git = |args: &[&str]| {
            String::from_utf8(
                Command::new("git")
                    .args(args)
                    .current_dir(env!("CARGO_MANIFEST_DIR"))
                    .output()
                    .unwrap()
                    .stdout,
            )
            .unwrap()
            .trim()
            .to_owned()
        };
        let tested = git(&["rev-parse", "HEAD"]);
        std::fs::write(path, serde_json::to_vec_pretty(&json!({"passed":true,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"sourceHeadSHA":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_|tested.clone()),"testedMergeSHA":tested,"sourceTreeDirty":!git(&["status","--porcelain","--untracked-files=no"]).is_empty(),"realService":"OpenSSH sshd + internal-sftp; temporary keys and known_hosts","authenticatedKeyLogin":true,"literalUnicodeTransfer":true,"cancelledOverwritePreservesOriginal":true,"transferQuitProtection":true,"networkInterruptedOverwritePreservesOriginal":true,"explicitRetryAfterReconnect":true,"hostCertificatesVerified":true,"interruptedRemoteTemporaryFilesMayRemain":true,"explicitDisconnectAndReconnect":true,"hostKeyMismatchRejected":true,"actualTunnelEcho":true,"staleTunnelStopRejected":true,"stopPreservesSiblingTunnel":true,"cleanup":true,"passwordServiceLogin":false,"nativeUIAcceptance":false})).unwrap()).unwrap();
    }
}
