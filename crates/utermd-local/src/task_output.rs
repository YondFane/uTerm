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
                stream.set_read_timeout(Some(POLL))?;
                let mut supplied = [0; 32];
                if stream.read_exact(&mut supplied).is_err() || supplied != secret.as_bytes() {
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
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    stream.write_all(token.as_bytes())?;
    Ok(Some(stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
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
    fn failed_start_does_not_leave_an_accept_thread() {
        let capture = Capture::start(|_| Ok(())).unwrap();
        let address = capture.address;
        drop(capture);
        assert!(TcpStream::connect(address).is_err());
    }
}
