use crate::{lock, Event, Session};
use anyhow::{bail, Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const VERSION: u32 = 1;
const MAX_MESSAGE: usize = 16 * 1024 * 1024;
const HISTORY_BYTES: usize = 1024 * 1024;
const MAX_CLOSED_HISTORY: usize = 16_384;

#[cfg(windows)]
const DETACHED_BACKGROUND_PROCESS_FLAGS: u32 = 0x0000_0008 | 0x0000_0200;
#[cfg(windows)]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
#[cfg(windows)]
const BACKGROUND_PROCESS_FLAGS: u32 = DETACHED_BACKGROUND_PROCESS_FLAGS | CREATE_BREAKAWAY_FROM_JOB;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSpec {
    pub id: String,
    pub directory: PathBuf,
    pub shell: String,
    pub agent: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Frame {
    #[serde(default)]
    pub agent_state: Option<String>,
    #[serde(default)]
    pub foreground_agent: Option<String>,
    pub sequence: u64,
    pub reset: bool,
    pub rows: u16,
    pub cols: u16,
    pub data: Vec<u8>,
    pub exited: bool,
    pub code: Option<u32>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub enum Operation {
    Ping,
    ListSessions,
    SessionSnapshot,
    HostStatus,
    ShutdownIfIdle,
    Open {
        spec: SessionSpec,
        rows: u16,
        cols: u16,
    },
    Read {
        id: String,
        generation: String,
        after: Option<u64>,
    },
    Write {
        id: String,
        generation: String,
        data: Vec<u8>,
    },
    Resize {
        id: String,
        generation: String,
        rows: u16,
        cols: u16,
    },
    Close {
        id: String,
        generation: String,
    },
    Report {
        id: String,
        generation: String,
        state: String,
    },
    ShutdownIfEmpty,
}
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub sessions: Vec<SessionSpec>,
    pub closed: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct HostedSession {
    pub spec: SessionSpec,
    pub generation: String,
    pub running: bool,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct HostStatus {
    pub pid: u32,
    pub executable: PathBuf,
    pub sessions: Vec<HostedSession>,
}
#[derive(Debug, Serialize, Deserialize)]
pub enum Reply {
    Sessions(Vec<SessionSpec>),
    SessionSnapshot(SessionSnapshot),
    HostStatus(HostStatus),
    Ready {
        pid: u32,
        #[serde(default)]
        capabilities: Vec<String>,
    },
    Opened {
        generation: String,
    },
    Frame(Frame),
    Done,
    Error(String),
}

#[derive(Serialize, Deserialize)]
struct Request {
    version: u32,
    token: String,
    operation: Operation,
}
#[derive(Clone, Serialize, Deserialize)]
struct Endpoint {
    version: u32,
    port: u16,
    token: String,
}

#[derive(Clone)]
pub struct Client {
    endpoint: Endpoint,
}
impl Client {
    pub fn connect(directory: &Path) -> Result<Self> {
        let endpoint: Endpoint =
            serde_json::from_slice(&std::fs::read(directory.join("endpoint.json"))?)?;
        if endpoint.version != VERSION {
            bail!("Local session host version is incompatible");
        }
        let client = Self { endpoint };
        match client.request(Operation::Ping)? {
            Reply::Ready { .. } => Ok(client),
            _ => bail!("Invalid response from local session host"),
        }
    }
    pub fn require_agent_support(&self) -> Result<()> {
        if matches!(self.request(Operation::Ping)?, Reply::Ready { capabilities, .. } if capabilities.iter().any(|value| value == "agent-reports-v1"))
        {
            return Ok(());
        }
        bail!("后台服务不支持 Agent 会话。请关闭会话并重新启动应用；已有进程未被终止。");
    }
    pub fn request(&self, operation: Operation) -> Result<Reply> {
        let address = SocketAddr::from(([127, 0, 0, 1], self.endpoint.port));
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        send(
            &mut stream,
            &Request {
                version: VERSION,
                token: self.endpoint.token.clone(),
                operation,
            },
        )?;
        match receive(&mut stream)? {
            Reply::Error(error) => bail!("{error}"),
            reply => Ok(reply),
        }
    }
}

fn private_directory(directory: &Path) -> Result<()> {
    std::fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = std::fs::symlink_metadata(directory)?;
        if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
            bail!("Session directory is not owned by this user");
        }
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    Ok(options.open(path)?)
}

pub fn ensure_update_safe(directory: &Path) -> Result<()> {
    private_directory(directory)?;
    let ownership = private_file(&directory.join("host.lock"))?;
    match ownership.try_lock() {
        Ok(()) => return Ok(()),
        Err(std::fs::TryLockError::WouldBlock) => {}
        Err(error) => return Err(error.into()),
    }
    let client = Client::connect(directory)?;
    if matches!(client.request(Operation::Ping)?, Reply::Ready { capabilities, .. }
        if capabilities.iter().any(|value| value == "detached-executable-v1"))
    {
        return Ok(());
    }
    bail!("后台服务无法确认安全更新。请先关闭全部会话，退出应用并等待后台结束，再重新打开应用安装更新；已有任务未被终止。");
}

pub fn ensure_running(directory: &Path, executable: &Path) -> Result<Client> {
    private_directory(directory)?;
    if let Ok(client) = Client::connect(directory) {
        return Ok(client);
    }
    let startup = private_file(&directory.join("startup.lock"))?;
    startup.lock().context("locking local session startup")?;
    if let Ok(client) = Client::connect(directory) {
        return Ok(client);
    }
    // Never overwrite the endpoint of a live but incompatible/unresponsive host.
    let host_lock = private_file(&directory.join("host.lock"))?;
    host_lock.try_lock().context(
        "The local session host is running but unavailable; existing sessions were left intact",
    )?;
    host_lock.unlock()?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("host.log"))?;
    let mut command = Command::new(executable);
    command
        .arg("--local-daemon")
        .arg(directory)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child =
        spawn_background_process(&mut command).context("starting local session host")?;
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Ok(client) = Client::connect(directory) {
            // Reap only after it exits; dropping the application never terminates it.
            std::thread::spawn(move || {
                if let Err(error) = child.wait() {
                    eprintln!("local host wait: {error}");
                }
            });
            return Ok(client);
        }
        if let Some(status) = child.try_wait()? {
            bail!("Local session host exited: {status}; see host.log");
        }
        if Instant::now() >= deadline {
            bail!("Local session host did not become ready; see host.log");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn spawn_background_process(command: &mut Command) -> Result<Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.creation_flags(BACKGROUND_PROCESS_FLAGS);
        return match command.spawn() {
            Ok(child) => Ok(child),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                // Some managed environments prohibit breakaway children. They still need a
                // usable local host, even though the parent Job controls its lifetime.
                eprintln!(
                    "utermd-local: could not detach the session host from its parent Job: {error}"
                );
                command.creation_flags(DETACHED_BACKGROUND_PROCESS_FLAGS);
                command.spawn().map_err(Into::into)
            }
            Err(error) => Err(error.into()),
        };
    }
    #[cfg(not(windows))]
    {
        command.spawn().map_err(Into::into)
    }
}

fn send<W: Write>(stream: &mut W, value: &impl Serialize) -> Result<()> {
    let data = serde_json::to_vec(value)?;
    if data.len() > MAX_MESSAGE {
        bail!("Local message is too large");
    }
    stream.write_all(&(data.len() as u32).to_be_bytes())?;
    stream.write_all(&data)?;
    Ok(())
}
fn receive<T: DeserializeOwned, R: Read>(stream: &mut R) -> Result<T> {
    let mut length = [0; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_MESSAGE {
        bail!("Invalid local message length");
    }
    let mut data = vec![0; length];
    stream.read_exact(&mut data)?;
    Ok(serde_json::from_slice(&data)?)
}

#[derive(Default)]
struct TerminalReplies {
    bytes: Vec<u8>,
}
impl vt100::Callbacks for TerminalReplies {
    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        prefix: Option<u8>,
        intermediate: Option<u8>,
        parameters: &[&[u16]],
        command: char,
    ) {
        let parameter = parameters
            .first()
            .and_then(|value| value.first())
            .copied()
            .unwrap_or(0);
        let reply = match (prefix, intermediate, command, parameter) {
            (None, None, 'n', 5) => "\x1b[0n".into(),
            (None, None, 'n', 6) | (Some(b'?'), None, 'n', 6) => {
                let (row, column) = screen.cursor_position();
                format!(
                    "\x1b[{}{};{}R",
                    if prefix.is_some() { "?" } else { "" },
                    row + 1,
                    column + 1
                )
            }
            (None, None, 'c', 0) => "\x1b[?1;2c".into(),
            (Some(b'>'), None, 'c', 0) => "\x1b[>0;1;0c".into(),
            (None, None, 't', 18) => {
                let (rows, cols) = screen.size();
                format!("\x1b[8;{rows};{cols}t")
            }
            (Some(b'?'), Some(b'$'), 'p', mode) => {
                let enabled = match mode {
                    1 => Some(screen.application_cursor()),
                    25 => Some(!screen.hide_cursor()),
                    1049 => Some(screen.alternate_screen()),
                    2004 => Some(screen.bracketed_paste()),
                    _ => None,
                };
                format!(
                    "\x1b[?{mode};{}$y",
                    enabled.map_or(0, |enabled| if enabled { 1 } else { 2 })
                )
            }
            _ => String::new(),
        };
        self.bytes.extend_from_slice(reply.as_bytes());
    }
    fn unhandled_osc(&mut self, _: &mut vt100::Screen, parameters: &[&[u8]]) {
        if parameters.get(1) != Some(&b"?".as_slice()) {
            return;
        }
        let reply = match parameters.first().copied() {
            Some(b"10") => "\x1b]10;rgb:c8c8/cdcd/d3d3\x1b\\",
            Some(b"11") => "\x1b]11;rgb:2121/2121/2121\x1b\\",
            _ => "",
        };
        self.bytes.extend_from_slice(reply.as_bytes());
    }
}

struct Output {
    parser: vt100::Parser<TerminalReplies>,
    sequence: u64,
    chunks: VecDeque<(u64, Vec<u8>)>,
    bytes: usize,
    exited: bool,
    code: Option<u32>,
    error: Option<String>,
    agent_state: Option<String>,
    foreground_agent: Option<String>,
}

impl Output {
    fn new(rows: u16, cols: u16, agent: Option<&str>) -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(rows, cols, 3000, TerminalReplies::default()),
            sequence: 0,
            chunks: VecDeque::new(),
            bytes: 0,
            exited: false,
            code: None,
            error: None,
            agent_state: agent.map(|_| "idle".into()),
            foreground_agent: None,
        }
    }

    fn reset_parser(&mut self, rows: u16, cols: u16) {
        self.parser =
            vt100::Parser::new_with_callbacks(rows, cols, 3000, TerminalReplies::default());
    }

    fn record(&mut self, event: Event) {
        self.sequence += 1;
        match event {
            Event::Output { data, .. } => {
                let (rows, cols) = self.parser.screen().size();
                let parsed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    self.parser.process(&data);
                }));
                if parsed.is_err() {
                    // A malformed or resize-interleaved escape sequence must not take the PTY
                    // reader down with the display cache. Keep streaming raw bytes to xterm and
                    // rebuild only the host-side replay buffer.
                    self.reset_parser(rows, cols);
                    self.error = Some("终端显示缓存已重置；会话仍在运行。".into());
                } else {
                    self.error = None;
                }
                self.bytes += data.len();
                self.chunks.push_back((self.sequence, data));
                while self.bytes > HISTORY_BYTES {
                    if let Some((_, data)) = self.chunks.pop_front() {
                        self.bytes -= data.len();
                    }
                }
            }
            Event::Exit { code } => {
                self.exited = true;
                self.code = code;
                self.foreground_agent = None;
                if self.agent_state.is_some() {
                    self.agent_state = Some(if code == Some(0) { "done" } else { "error" }.into());
                }
            }
            Event::Error { message } => {
                self.error = Some(message);
            }
        }
    }
    fn frame(&self, after: Option<u64>) -> Frame {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let reset = after.is_none_or(|cursor| {
            cursor > self.sequence
                || self
                    .chunks
                    .front()
                    .is_some_and(|(first, _)| cursor + 1 < *first)
        });
        let data = if reset {
            self.snapshot()
        } else {
            self.chunks
                .iter()
                .filter(|(sequence, _)| after.is_some_and(|cursor| *sequence > cursor))
                .flat_map(|(_, data)| data.iter().copied())
                .collect()
        };
        Frame {
            agent_state: self.agent_state.clone(),
            foreground_agent: self.foreground_agent.clone(),
            sequence: self.sequence,
            reset,
            rows,
            cols,
            data,
            exited: self.exited,
            code: self.code,
            error: self.error.clone(),
        }
    }
    fn snapshot(&self) -> Vec<u8> {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let mut data = b"\x1bc".to_vec();
        if screen.alternate_screen() {
            data.extend_from_slice(b"\x1b[?1049h");
        } else {
            let mut history = screen.clone();
            history.set_scrollback(3000);
            let count = history.scrollback();
            for offset in (1..=count).rev() {
                history.set_scrollback(offset);
                if let Some(line) = history.rows(0, cols).next() {
                    data.extend_from_slice(line.as_bytes());
                }
                data.extend_from_slice(b"\r\n");
            }
            if count > 0 {
                for _ in 1..rows {
                    data.extend_from_slice(b"\r\n");
                }
            }
        }
        data.extend(screen.state_formatted());
        data
    }
}
struct Entry {
    spec: SessionSpec,
    generation: String,
    session: Arc<Session>,
    output: Arc<(Mutex<Output>, Condvar)>,
}
struct Host {
    directory: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Entry>>>,
    closed_sessions: Mutex<HashSet<String>>,
    stopping: Arc<AtomicBool>,
    #[cfg(windows)]
    processes: Mutex<ProcessCache>,
}

#[cfg(windows)]
#[derive(Default)]
struct ProcessCache {
    refreshed: Option<Instant>,
    entries: HashMap<u32, crate::process::ProcessEntry>,
}

impl Host {
    #[cfg(windows)]
    fn foreground_agent(&self, shell: Option<u32>) -> Result<Option<String>> {
        let Some(shell) = shell else { return Ok(None) };
        let mut cache = lock(&self.processes);
        if cache
            .refreshed
            .is_none_or(|refreshed| refreshed.elapsed() >= Duration::from_secs(1))
        {
            cache.refreshed = Some(Instant::now());
            cache.entries = crate::process::process_snapshot()?;
        }
        Ok(crate::process::agent_in_process_tree(shell, &cache.entries).map(str::to_owned))
    }

    fn entry(&self, id: &str, generation: &str) -> Result<Arc<Entry>> {
        let entry = lock(&self.sessions)
            .get(id)
            .cloned()
            .context("Session no longer exists")?;
        if entry.generation != generation {
            bail!("Session was replaced; reconnect before sending input");
        }
        Ok(entry)
    }

    fn open_session(&self, spec: SessionSpec, rows: u16, cols: u16) -> Result<Arc<Entry>> {
        crate::size(rows, cols)?;
        if spec.id.is_empty() || spec.id.len() > 200 {
            bail!("Invalid session identifier");
        }
        let mut sessions = lock(&self.sessions);
        if self.stopping.load(Ordering::Acquire) {
            bail!("Session host is restarting; reconnect before opening a session");
        }
        if let Some(entry) = sessions.get(&spec.id) {
            if entry.spec != spec {
                bail!("Session configuration differs from its running process");
            }
            return Ok(entry.clone());
        }
        if lock(&self.closed_sessions).contains(&spec.id) {
            bail!("Session was explicitly closed; create a new session instead");
        }
        if sessions.len() >= 128 {
            bail!("Close an existing session before starting another");
        }
        if lock(&self.closed_sessions).len() >= MAX_CLOSED_HISTORY {
            bail!(
                "Session history limit reached; close running sessions and safely restart the host"
            );
        }
        let output = Arc::new((
            Mutex::new(Output::new(rows, cols, spec.agent.as_deref())),
            Condvar::new(),
        ));
        let sink = output.clone();
        let (reply_sender, reply_receiver) = mpsc::sync_channel::<Vec<u8>>(64);
        let generation = uuid::Uuid::new_v4().to_string();
        let mut command = crate::process::launch_command(
            &spec.shell,
            spec.agent.as_deref(),
            self.directory
                .parent()
                .context("Host directory has no parent")?,
        )?;
        command.env("UTERM_DESKTOP_HOST", &self.directory);
        command.env("UTERM_DESKTOP_REPORTER", std::env::current_exe()?);
        command.env("UTERM_DESKTOP_SESSION", &spec.id);
        command.env("UTERM_DESKTOP_GENERATION", &generation);
        let session =
            Session::spawn_background(command, &spec.directory, rows, cols, move |event| {
                let mut output = lock(&sink.0);
                output.record(event);
                let replies = std::mem::take(&mut output.parser.callbacks_mut().bytes);
                drop(output);
                sink.1.notify_all();
                if !replies.is_empty() {
                    reply_sender
                        .try_send(replies)
                        .context("Terminal reply queue is full")?;
                }
                Ok(())
            })?;
        let session = Arc::new(session);
        let weak_session = Arc::downgrade(&session);
        std::thread::spawn(move || {
            while let Ok(data) = reply_receiver.recv() {
                let Some(session) = weak_session.upgrade() else {
                    break;
                };
                for chunk in data.chunks(16 * 1024) {
                    if let Err(error) = session.write(chunk.to_vec()) {
                        eprintln!("Terminal reply failed: {error}");
                        break;
                    }
                }
            }
        });
        let entry = Arc::new(Entry {
            spec,
            generation,
            session,
            output,
        });
        sessions.insert(entry.spec.id.clone(), entry.clone());
        Ok(entry)
    }

    fn dispatch(&self, operation: Operation) -> Result<Reply> {
        match operation {
            Operation::Report {
                id,
                generation,
                state,
            } => {
                if !["idle", "working", "waiting", "done"].contains(&state.as_str()) {
                    bail!("Invalid agent state");
                }
                let entry = self.entry(&id, &generation)?;
                let mut output = lock(&entry.output.0);
                if !output.exited && output.agent_state.as_ref() != Some(&state) {
                    output.agent_state = Some(state);
                    output.sequence += 1;
                }
                drop(output);
                entry.output.1.notify_all();
                Ok(Reply::Done)
            }
            Operation::Ping => Ok(Reply::Ready {
                pid: std::process::id(),
                capabilities: {
                    let mut values = vec![
                        "agent-reports-v1".into(),
                        "local-session-list-v1".into(),
                        "local-session-snapshot-v1".into(),
                        "local-host-management-v1".into(),
                    ];
                    if std::env::current_exe()?
                        .file_stem()
                        .is_some_and(|name| name == "uterm-session-host")
                    {
                        values.push("detached-executable-v1".into());
                    }
                    values
                },
            }),
            Operation::HostStatus => Ok(Reply::HostStatus(HostStatus {
                pid: std::process::id(),
                executable: std::env::current_exe()?,
                sessions: lock(&self.sessions)
                    .values()
                    .map(|entry| HostedSession {
                        spec: entry.spec.clone(),
                        generation: entry.generation.clone(),
                        running: !lock(&entry.output.0).exited,
                    })
                    .collect(),
            })),
            Operation::ShutdownIfIdle => {
                let sessions = lock(&self.sessions);
                if sessions.values().any(|entry| !lock(&entry.output.0).exited) {
                    bail!("Sessions are still running; restart cancelled");
                }
                self.stopping.store(true, Ordering::Release);
                Ok(Reply::Done)
            }
            Operation::SessionSnapshot => {
                let entries = lock(&self.sessions);
                let closed = lock(&self.closed_sessions);
                Ok(Reply::SessionSnapshot(SessionSnapshot {
                    sessions: entries
                        .values()
                        .filter(|entry| {
                            !lock(&entry.output.0).exited && !closed.contains(&entry.spec.id)
                        })
                        .map(|entry| entry.spec.clone())
                        .collect(),
                    closed: closed.iter().cloned().collect(),
                }))
            }
            Operation::ListSessions => Ok(Reply::Sessions(
                lock(&self.sessions)
                    .values()
                    .filter(|entry| !lock(&entry.output.0).exited)
                    .map(|entry| entry.spec.clone())
                    .collect(),
            )),
            Operation::Open { spec, rows, cols } => {
                let entry = self.open_session(spec, rows, cols)?;
                Ok(Reply::Opened {
                    generation: entry.generation.clone(),
                })
            }
            Operation::Read {
                id,
                generation,
                after,
            } => {
                let entry = self.entry(&id, &generation)?;
                #[cfg(windows)]
                if entry.spec.agent.is_none() {
                    match self.foreground_agent(entry.session.process_id()) {
                        Ok(agent) => {
                            let mut output = lock(&entry.output.0);
                            if !output.exited && output.foreground_agent != agent {
                                output.foreground_agent = agent;
                                output.sequence += 1;
                                entry.output.1.notify_all();
                            }
                        }
                        Err(error) => eprintln!("Could not identify foreground agent: {error:#}"),
                    }
                }
                let output = lock(&entry.output.0);
                let output = if after == Some(output.sequence) && !output.exited {
                    entry
                        .output
                        .1
                        .wait_timeout(output, Duration::from_millis(500))
                        .map_err(|_| anyhow::anyhow!("Output lock was poisoned"))?
                        .0
                } else {
                    output
                };
                Ok(Reply::Frame(output.frame(after)))
            }
            Operation::Write {
                id,
                generation,
                data,
            } => {
                self.entry(&id, &generation)?.session.write(data)?;
                Ok(Reply::Done)
            }
            Operation::Resize {
                id,
                generation,
                rows,
                cols,
            } => {
                let entry = self.entry(&id, &generation)?;
                crate::size(rows, cols)?;
                if !lock(&entry.output.0).exited {
                    entry.session.resize(rows, cols)?;
                    lock(&entry.output.0)
                        .parser
                        .screen_mut()
                        .set_size(rows, cols);
                }
                Ok(Reply::Done)
            }
            Operation::Close { id, generation } => {
                let mut sessions = lock(&self.sessions);
                if let Some(entry) = sessions.get(&id) {
                    if entry.generation != generation {
                        bail!("Session was replaced; close cancelled");
                    }
                    entry.session.close()?;
                    lock(&self.closed_sessions).insert(id.clone());
                    sessions.remove(&id);
                }
                Ok(Reply::Done)
            }
            Operation::ShutdownIfEmpty => {
                if !lock(&self.sessions).is_empty() {
                    bail!("Sessions are still running");
                }
                self.stopping.store(true, Ordering::Release);
                Ok(Reply::Done)
            }
        }
    }
}

pub fn serve(directory: &Path) -> Result<()> {
    private_directory(directory)?;
    let ownership = private_file(&directory.join("host.lock"))?;
    ownership
        .try_lock()
        .context("A local session host already owns this directory")?;
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let endpoint = Endpoint {
        version: VERSION,
        port: listener.local_addr()?.port(),
        token: uuid::Uuid::new_v4().to_string(),
    };
    let mut file = private_file(&directory.join("endpoint.json"))?;
    file.set_len(0)?;
    file.write_all(&serde_json::to_vec(&endpoint)?)?;
    file.sync_all()?;
    let host = Arc::new(Host {
        directory: directory.to_owned(),
        sessions: Mutex::new(HashMap::new()),
        closed_sessions: Mutex::new(HashSet::new()),
        stopping: Arc::new(AtomicBool::new(false)),
        #[cfg(windows)]
        processes: Mutex::new(ProcessCache::default()),
    });
    let active = Arc::new(AtomicUsize::new(0));
    let mut last_used = Instant::now();
    while !host.stopping.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                last_used = Instant::now();
                if active.load(Ordering::Acquire) >= 256 {
                    continue;
                }
                // macOS inherits the listener's nonblocking mode on accepted sockets.
                stream.set_nonblocking(false)?;
                stream.set_read_timeout(Some(Duration::from_secs(3)))?;
                stream.set_write_timeout(Some(Duration::from_secs(10)))?;
                let token = endpoint.token.clone();
                let host = host.clone();
                let active = active.clone();
                active.fetch_add(1, Ordering::AcqRel);
                std::thread::spawn(move || {
                    let result = (|| -> Result<()> {
                        let request: Request = receive(&mut stream)?;
                        if request.version != VERSION || request.token != token {
                            bail!("Local session authentication failed");
                        }
                        let reply = host
                            .dispatch(request.operation)
                            .unwrap_or_else(|error| Reply::Error(format!("{error:#}")));
                        send(&mut stream, &reply)
                    })();
                    if let Err(error) = result {
                        eprintln!("local session connection: {error:#}");
                    }
                    active.fetch_sub(1, Ordering::AcqRel);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(error) => return Err(error.into()),
        }
        if last_used.elapsed() > Duration::from_secs(60)
            && active.load(Ordering::Acquire) == 0
            && lock(&host.sessions).is_empty()
        {
            break;
        }
    }
    std::fs::remove_file(directory.join("endpoint.json"))?;
    Ok(())
}

pub fn report_from_environment(state: String) -> Result<()> {
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
        std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink())?;
    }
    let Some(directory) = std::env::var_os("UTERM_DESKTOP_HOST") else {
        return Ok(());
    };
    let id = std::env::var("UTERM_DESKTOP_SESSION")?;
    let generation = std::env::var("UTERM_DESKTOP_GENERATION")?;
    Client::connect(Path::new(&directory))?.request(Operation::Report {
        id,
        generation,
        state,
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resetting_output_cache_preserves_future_terminal_output() {
        let mut output = Output::new(24, 80, None);
        output.record(Event::Output {
            sequence: 1,
            data: b"before".to_vec(),
        });
        output.reset_parser(24, 80);
        output.record(Event::Output {
            sequence: 2,
            data: b"after".to_vec(),
        });

        let frame = output.frame(Some(1));
        assert_eq!(frame.data, b"after");
        assert!(!frame.exited);
        assert!(frame.error.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn background_host_breaks_away_from_the_parent_job() {
        assert_ne!(BACKGROUND_PROCESS_FLAGS & CREATE_BREAKAWAY_FROM_JOB, 0);
    }
}
