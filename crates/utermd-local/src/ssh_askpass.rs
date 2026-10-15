use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const LIMIT: usize = 16 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}
impl Endpoint {
    pub fn environment(&self) -> Result<Vec<(&'static str, String)>> {
        if self.port == 0 || uuid::Uuid::parse_str(&self.token).is_err() {
            bail!("SSH_AUTH_FAILED");
        }
        Ok(vec![
            (
                "SSH_ASKPASS",
                std::env::current_exe()?.to_string_lossy().into_owned(),
            ),
            ("SSH_ASKPASS_REQUIRE", "force".into()),
            ("UTERM_SSH_ASKPASS", "1".into()),
            ("UTERM_SSH_ASKPASS_PORT", self.port.to_string()),
            ("UTERM_SSH_ASKPASS_TOKEN", self.token.clone()),
        ])
    }
}
#[derive(Serialize, Deserialize)]
struct Request {
    token: String,
    prompt: String,
}
pub struct Server {
    pub endpoint: Endpoint,
    stopped: Arc<AtomicBool>,
    expires: Instant,
    worker: std::thread::Thread,
}
impl Server {
    pub fn new(
        password: String,
        expected: String,
        confirm: impl Fn(&str) -> bool + Send + 'static,
    ) -> Result<Self> {
        if password.is_empty() || password.len() > 1023 || password.contains(['\0', '\r', '\n']) {
            bail!("SSH_PASSWORD_INVALID");
        }
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let endpoint = Endpoint {
            port: listener.local_addr()?.port(),
            token: uuid::Uuid::new_v4().to_string(),
        };
        let stopped = Arc::new(AtomicBool::new(false));
        let done = stopped.clone();
        let token = endpoint.token.clone();
        let expires = Instant::now() + Duration::from_secs(120);
        let worker = std::thread::spawn(move || {
            let mut password = Some(password);
            while !done.load(Ordering::Acquire) && Instant::now() < expires {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                        let result = (|| -> Result<()> {
                            let request: Request = read(&mut stream)?;
                            if request.token != token {
                                bail!("SSH_AUTH_FAILED");
                            }
                            // Only OpenSSH's destination password prompt receives the one-use secret. 只有 OpenSSH 生成的目标密码提示可取得一次性凭据。
                            let answer = if request.prompt.trim_end() == expected {
                                password.take()
                            } else if request
                                .prompt
                                .contains("Are you sure you want to continue connecting")
                                && request.prompt.contains("fingerprint")
                            {
                                let approved = confirm(&request.prompt);
                                if !approved {
                                    password.take();
                                }
                                Some(if approved { "yes" } else { "no" }.into())
                            } else {
                                None
                            };
                            if done.load(Ordering::Acquire) || Instant::now() >= expires {
                                bail!("SSH_AUTH_FAILED");
                            }
                            write(&mut stream, &answer)?;
                            Ok(())
                        })();
                        let _ = result;
                        if password.is_none() {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::park_timeout(Duration::from_millis(100))
                    }
                    Err(_) => break,
                }
            }
            done.store(true, Ordering::Release);
        });
        Ok(Self {
            endpoint,
            stopped,
            expires,
            worker: worker.thread().clone(),
        })
    }
    pub fn finished(&self) -> bool {
        self.stopped.load(Ordering::Acquire) || Instant::now() >= self.expires
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.worker.unpark();
    }
}
fn write<T: Serialize>(stream: &mut TcpStream, value: &T) -> Result<()> {
    let data = serde_json::to_vec(value)?;
    if data.len() > LIMIT {
        bail!("SSH_AUTH_FAILED");
    }
    stream.write_all(&(data.len() as u32).to_be_bytes())?;
    stream.write_all(&data)?;
    Ok(())
}
fn read<T: serde::de::DeserializeOwned>(stream: &mut TcpStream) -> Result<T> {
    let mut length = [0; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > LIMIT {
        bail!("SSH_AUTH_FAILED");
    }
    let mut data = vec![0; length];
    stream.read_exact(&mut data)?;
    Ok(serde_json::from_slice(&data)?)
}
pub fn requested() -> bool {
    std::env::var("UTERM_SSH_ASKPASS").as_deref() == Ok("1")
}
pub fn run() -> Result<()> {
    let port: u16 = std::env::var("UTERM_SSH_ASKPASS_PORT")?.parse()?;
    let token = std::env::var("UTERM_SSH_ASKPASS_TOKEN")?;
    uuid::Uuid::parse_str(&token)?;
    let prompt = std::env::args().nth(1).context("SSH_AUTH_FAILED")?;
    let mut stream =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(120)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    write(&mut stream, &Request { token, prompt })?;
    let answer: Option<String> = read(&mut stream)?;
    let answer = answer.context("SSH_AUTH_FAILED")?;
    std::io::stdout().write_all(answer.as_bytes())?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}
