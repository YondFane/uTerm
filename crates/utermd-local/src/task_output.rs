use anyhow::{bail, Context, Result};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub(crate) const ADDRESS: &str = "UTERM_TASK_OUTPUT_ADDRESS";
pub(crate) const TOKEN: &str = "UTERM_TASK_OUTPUT_TOKEN";
const POLL: Duration = Duration::from_millis(250);
const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(5);

fn read_token(
    reader: &mut impl Read,
    stopping: &AtomicBool,
    deadline: Instant,
) -> std::io::Result<[u8; 32]> {
    let mut supplied = [0; 32];
    let mut received = 0;
    // A socket poll timeout is shorter than the peer's write budget; retain partial token bytes.
    // 套接字轮询超时短于对端写入期限，因此保留已经收到的令牌字节。
    loop {
        match reader.read(&mut supplied[received..]) {
            Ok(0) => return Err(std::io::ErrorKind::UnexpectedEof.into()),
            Ok(count) => {
                received += count;
                if received == supplied.len() {
                    return Ok(supplied);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if stopping.load(Ordering::Acquire) {
                    return Err(std::io::ErrorKind::Interrupted.into());
                }
            }
            Err(error) => return Err(error),
        }
        if Instant::now() >= deadline {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
    }
}

pub(crate) struct Capture {
    address: SocketAddr,
    token: String,
    pub connected: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    worker: Option<JoinHandle<Result<()>>>,
}
impl Capture {
    pub fn start(sink: impl Fn(Vec<u8>) -> Result<()> + Send + 'static) -> Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let secret = token.clone();
        let connected = Arc::new(AtomicBool::new(false));
        let authenticated = connected.clone();
        let finished = Arc::new(AtomicBool::new(false));
        let stopping = finished.clone();
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                let (mut stream, _) = match listener.accept() {
                    Ok(client) => client,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if stopping.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        if Instant::now() >= deadline {
                            bail!("JAVA_TASK_OUTPUT_FAILED");
                        }
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                // macOS inherits nonblocking mode; authentication must wait for the token bytes.
                // macOS 会继承非阻塞模式；认证时必须等待令牌字节到达。
                stream.set_nonblocking(false)?;
                stream.set_read_timeout(Some(POLL))?;
                let auth_deadline = (Instant::now() + AUTHENTICATION_TIMEOUT).min(deadline);
                let Ok(supplied) = read_token(&mut stream, &stopping, auth_deadline) else {
                    continue;
                };
                if supplied != secret.as_bytes() {
                    continue;
                }
                authenticated.store(true, Ordering::Release);
                let mut buffer = [0; 16 * 1024];
                loop {
                    match stream.read(&mut buffer) {
                        Ok(0) => return Ok(()),
                        Ok(count) => sink(buffer[..count].to_vec())?,
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::ConnectionReset
                                    | std::io::ErrorKind::ConnectionAborted
                            ) =>
                        {
                            return Ok(())
                        }
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) =>
                        {
                            if stopping.load(Ordering::Acquire) {
                                return Ok(());
                            }
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
            }
        });
        Ok(Self {
            address,
            token,
            connected,
            finished,
            worker: Some(worker),
        })
    }
    pub fn configure(&self, command: &mut portable_pty::CommandBuilder) {
        command.env(ADDRESS, self.address.to_string());
        command.env(TOKEN, &self.token);
    }
    pub fn finish(mut self) -> Result<()> {
        self.finished.store(true, Ordering::Release);
        self.worker
            .take()
            .context("JAVA_TASK_OUTPUT_FAILED")?
            .join()
            .map_err(|_| anyhow::anyhow!("JAVA_TASK_OUTPUT_FAILED"))?
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub(crate) fn connect() -> Result<Option<TcpStream>> {
    let Some(address) = std::env::var_os(ADDRESS) else {
        return Ok(None);
    };
    let address: SocketAddr = address
        .to_str()
        .context("JAVA_TASK_OUTPUT_FAILED")?
        .parse()?;
    let token = std::env::var(TOKEN)?;
    if !address.ip().is_loopback() || token.len() != 32 {
        bail!("JAVA_TASK_OUTPUT_FAILED");
    }
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
    stream.set_nodelay(true)?;
    stream.set_write_timeout(Some(AUTHENTICATION_TIMEOUT))?;
    stream.write_all(token.as_bytes())?;
    Ok(Some(stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    struct Reads(std::collections::VecDeque<std::result::Result<Vec<u8>, std::io::ErrorKind>>);
    impl Read for Reads {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            match self.0.pop_front() {
                None => Ok(0),
                Some(Err(kind)) => Err(std::io::Error::new(kind, "controlled socket poll")),
                Some(Ok(bytes)) => {
                    let count = bytes.len().min(buffer.len());
                    buffer[..count].copy_from_slice(&bytes[..count]);
                    if count < bytes.len() {
                        self.0.push_front(Ok(bytes[count..].to_vec()));
                    }
                    Ok(count)
                }
            }
        }
    }
    #[test]
    fn fragmented_token_survives_socket_poll_timeouts() {
        let expected = *b"0123456789abcdef0123456789abcdef";
        for kind in [
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::WouldBlock,
            std::io::ErrorKind::Interrupted,
        ] {
            let mut reader = Reads(
                [
                    Ok(expected[..8].to_vec()),
                    Err(kind),
                    Ok(expected[8..].to_vec()),
                ]
                .into(),
            );
            let actual = read_token(
                &mut reader,
                &AtomicBool::new(false),
                Instant::now() + AUTHENTICATION_TIMEOUT,
            )
            .unwrap();
            assert_eq!(actual, expected);
        }
    }
    #[test]
    fn token_retry_stops_on_shutdown_or_expired_authentication() {
        let expected = b"0123456789abcdef0123456789abcdef";
        for (stopping, deadline) in [
            (true, Instant::now() + AUTHENTICATION_TIMEOUT),
            (false, Instant::now() - Duration::from_secs(1)),
        ] {
            let mut reader =
                Reads([Err(std::io::ErrorKind::TimedOut), Ok(expected.to_vec())].into());
            assert!(read_token(&mut reader, &AtomicBool::new(stopping), deadline).is_err());
        }
    }
    #[test]
    fn real_socket_preserves_fragmented_authentication_beyond_one_poll() {
        let data = Arc::new(Mutex::new(Vec::new()));
        let sink = data.clone();
        let capture = Capture::start(move |bytes| {
            sink.lock().unwrap().extend(bytes);
            Ok(())
        })
        .unwrap();
        let connected = capture.connected.clone();
        let address = capture.address;
        let mut peer = TcpStream::connect(address).unwrap();
        peer.write_all(&capture.token.as_bytes()[..8]).unwrap();
        std::thread::sleep(POLL + Duration::from_millis(100));
        peer.write_all(&capture.token.as_bytes()[8..]).unwrap();
        let expected = "fragmented-output-中文\n".as_bytes();
        peer.write_all(expected).unwrap();
        drop(peer);
        capture.finish().unwrap();
        assert!(connected.load(Ordering::Acquire));
        assert_eq!(*data.lock().unwrap(), expected);
        assert!(TcpStream::connect(address).is_err());
        if let Some(path) = std::env::var_os("UTERM_TASK_OUTPUT_AUTH_REPORT") {
            let git = |args: &[&str]| {
                let output = std::process::Command::new("git")
                    .args(args)
                    .current_dir(env!("CARGO_MANIFEST_DIR"))
                    .output()
                    .unwrap();
                assert!(output.status.success());
                String::from_utf8(output.stdout).unwrap().trim().to_owned()
            };
            let tested = git(&["rev-parse", "HEAD"]);
            std::fs::write(path, serde_json::to_vec_pretty(&serde_json::json!({
                "passed":true,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
                "sourceHeadSHA":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_|tested.clone()),
                "testedMergeSHA":tested,"sourceTreeDirty":!git(&["status","--porcelain","--untracked-files=no"]).is_empty(),
                "actualLoopbackSockets":true,"controlledPeer":true,"actualTaskSubprocess":false,
                "tokenBytes":32,"pollMilliseconds":POLL.as_millis(),"authenticationBudgetMilliseconds":AUTHENTICATION_TIMEOUT.as_millis(),
                "fragmentedAcrossPoll":true,"authenticated":true,"exactOutputBytesDrained":expected.len(),"listenerReleased":true
            })).unwrap()).unwrap();
        }
    }
    #[test]
    fn closing_with_an_unauthenticated_peer_does_not_wait_for_its_auth_budget() {
        let capture = Capture::start(|_| Ok(())).unwrap();
        let peer = TcpStream::connect(capture.address).unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let closer = std::thread::spawn(move || {
            drop(capture);
            send.send(()).unwrap();
        });
        receive.recv_timeout(Duration::from_secs(3)).unwrap();
        drop(peer);
        closer.join().unwrap();
    }
    #[test]
    fn capture_authenticates_and_drains_before_exit() {
        let data = Arc::new(Mutex::new(Vec::new()));
        let sink = data.clone();
        let capture = Capture::start(move |bytes| {
            sink.lock().unwrap().extend(bytes);
            Ok(())
        })
        .unwrap();
        let mut invalid = TcpStream::connect(capture.address).unwrap();
        invalid.write_all(&[b'x'; 32]).unwrap();
        drop(invalid);
        let mut valid = TcpStream::connect(capture.address).unwrap();
        valid.write_all(capture.token.as_bytes()).unwrap();
        let expected = "完整日志 tail-marker\n".repeat(10000).into_bytes();
        valid.write_all(&expected).unwrap();
        drop(valid);
        capture.finish().unwrap();
        assert_eq!(*data.lock().unwrap(), expected);
    }
    #[test]
    fn capture_waits_for_delayed_authentication_bytes() {
        let data = Arc::new(Mutex::new(Vec::new()));
        let sink = data.clone();
        let capture = Capture::start(move |bytes| {
            sink.lock().unwrap().extend(bytes);
            Ok(())
        })
        .unwrap();
        let mut stream = TcpStream::connect(capture.address).unwrap();
        std::thread::sleep(Duration::from_millis(80));
        stream.write_all(capture.token.as_bytes()).unwrap();
        stream.write_all(b"delayed-auth-log\n").unwrap();
        drop(stream);
        let connected = capture.connected.clone();
        capture.finish().unwrap();
        assert!(connected.load(Ordering::Acquire));
        assert_eq!(*data.lock().unwrap(), b"delayed-auth-log\n");
    }
    #[test]
    fn failed_start_does_not_leave_an_accept_thread() {
        let capture = Capture::start(|_| Ok(())).unwrap();
        let address = capture.address;
        drop(capture);
        assert!(TcpStream::connect(address).is_err());
    }
}
