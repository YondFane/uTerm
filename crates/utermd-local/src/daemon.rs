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
const MAX_COMPLETED_TASKS: usize = 32;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<crate::ssh::SshTarget>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Frame {
    #[serde(default)]
    pub agent_activity_error: Option<String>,
    #[serde(default)]
    pub agent_events: Option<Vec<crate::activity::ActivityEvent>>,
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
    SshSessionSnapshot,
    HostStatus,
    TaskSnapshot,
    OpenTask {
        spec: SessionSpec,
        task: crate::tasks::TaskInfo,
        launch: crate::tasks::Launch,
        rows: u16,
        cols: u16,
    },
    Attach {
        id: String,
        rows: u16,
        cols: u16,
    },
    StopTask {
        id: String,
        generation: String,
        force: bool,
    },
    ClaimTask {
        id: String,
    },
    ShutdownIfIdle,
    Open {
        spec: SessionSpec,
        rows: u16,
        cols: u16,
    },
    OpenSsh {
        spec: SessionSpec,
        rows: u16,
        cols: u16,
        create: bool,
    },
    OpenSshConfigured {
        spec: SessionSpec,
        rows: u16,
        cols: u16,
        resolved: crate::ssh::ResolvedTarget,
        askpass: Option<crate::ssh_askpass::Endpoint>,
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
    AcknowledgeAgentEvent {
        id: String,
        generation: String,
        event: String,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskSession {
    pub spec: SessionSpec,
    pub generation: String,
    pub task: crate::tasks::TaskInfo,
    pub running: bool,
    pub code: Option<u32>,
}
#[derive(Debug, Serialize, Deserialize)]
pub enum Reply {
    Tasks(Vec<TaskSession>),
    TaskLaunch(crate::tasks::Launch),
    Sessions(Vec<SessionSpec>),
    SessionSnapshot(SessionSnapshot),
    SshSessionSnapshot(SessionSnapshot),
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
    pub fn require_task_support(&self) -> Result<()> {
        if matches!(self.request(Operation::Ping)?, Reply::Ready { capabilities, .. } if capabilities.iter().any(|value| value == "java-tasks-v1"))
        {
            return Ok(());
        }
        bail!("JAVA_HOST_UPGRADE_REQUIRED");
    }
    pub fn require_task_output_support(&self) -> Result<()> {
        if matches!(self.request(Operation::Ping)?, Reply::Ready { capabilities, .. } if capabilities.iter().any(|value| value == "task-pipe-output-v1"))
        {
            return Ok(());
        }
        bail!("JAVA_HOST_UPGRADE_REQUIRED");
    }
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
    pub fn require_ssh_support(&self) -> Result<()> {
        if matches!(self.request(Operation::Ping)?, Reply::Ready { capabilities, .. } if capabilities.iter().any(|value| value == "ssh-sessions-v1"))
        {
            return Ok(());
        }
        bail!("SSH_HOST_UPGRADE_REQUIRED");
    }
    pub fn require_ssh_config_support(&self) -> Result<()> {
        if matches!(self.request(Operation::Ping)?, Reply::Ready { capabilities, .. } if capabilities.iter().any(|value| value == "ssh-options-v1"))
        {
            return Ok(());
        }
        bail!("SSH_HOST_UPGRADE_REQUIRED");
    }
    pub fn require_ssh_jump_support(&self) -> Result<()> {
        if matches!(self.request(Operation::Ping)?, Reply::Ready { capabilities, .. } if capabilities.iter().any(|value| value == "ssh-jump-v1"))
        {
            return Ok(());
        }
        bail!("SSH_HOST_UPGRADE_REQUIRED");
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
pub(crate) struct TerminalReplies {
    pub(crate) bytes: Vec<u8>,
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
    notifications: crate::activity::TerminalNotifications,
    activity_events: VecDeque<crate::activity::ActivityEvent>,
    pending_notice: Option<Instant>,
    precise_activity: Option<Instant>,
    activity_error: Option<String>,
    structured_activity: bool,
    parser: vt100::Parser<TerminalReplies>,
    sequence: u64,
    chunks: VecDeque<(u64, Vec<u8>)>,
    task_log: bool,
    task_carriage_return: bool,
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
            notifications: Default::default(),
            activity_events: VecDeque::new(),
            pending_notice: None,
            precise_activity: None,
            activity_error: None,
            structured_activity: false,
            parser: vt100::Parser::new_with_callbacks(rows, cols, 3000, TerminalReplies::default()),
            sequence: 0,
            chunks: VecDeque::new(),
            task_log: false,
            task_carriage_return: false,
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
            Event::Output { mut data, .. } => {
                if self.task_log {
                    let mut normalized = Vec::with_capacity(data.len());
                    for byte in data {
                        if byte == b'\n' && !self.task_carriage_return {
                            normalized.push(b'\r');
                        }
                        self.task_carriage_return = byte == b'\r';
                        normalized.push(byte);
                    }
                    data = normalized;
                }
                if self.notifications.feed(&data) {
                    self.pending_notice.get_or_insert_with(Instant::now);
                }
                let (rows, cols) = self.parser.screen().size();
                let parsed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if !self.task_log {
                        self.parser.process(&data);
                    }
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
                    if code != Some(0)
                        || self
                            .activity_events
                            .back()
                            .is_none_or(|event| event.kind != "done")
                        || self
                            .precise_activity
                            .is_none_or(|time| time.elapsed() > Duration::from_secs(1))
                    {
                        self.activity(if code == Some(0) { "done" } else { "error" }, "process");
                    }
                }
            }
            Event::Error { message } => {
                self.error = Some(message);
            }
        }
    }
    fn activity(&mut self, kind: &str, source: &str) {
        self.sequence += 1;
        if source != "terminal" {
            self.pending_notice = None;
            if matches!(kind, "done" | "waiting" | "error") {
                self.precise_activity = Some(Instant::now());
            }
            self.agent_state = Some(kind.into());
        } else {
            self.agent_state = Some("notice".into());
        }
        self.activity_events
            .push_back(crate::activity::ActivityEvent {
                id: uuid::Uuid::new_v4().to_string(),
                sequence: self.sequence,
                kind: kind.into(),
                source: source.into(),
            });
        while self.activity_events.len() > 128 {
            self.activity_events.pop_front();
        }
    }
    fn flush_notice(&mut self) {
        if self
            .precise_activity
            .is_some_and(|time| time.elapsed() < Duration::from_secs(1))
        {
            self.pending_notice = None;
            return;
        }
        if self.pending_notice.is_some_and(|time| {
            time.elapsed()
                >= Duration::from_millis(if self.structured_activity { 1500 } else { 400 })
        }) {
            self.pending_notice = None;
            if self
                .precise_activity
                .is_none_or(|time| time.elapsed() > Duration::from_secs(1))
            {
                self.activity("notice", "terminal");
            }
        }
    }
    fn acknowledge_activity(&mut self, expected: Option<&str>) {
        if expected.is_none_or(|id| {
            self.activity_events
                .back()
                .is_some_and(|event| event.id == id)
        }) && matches!(self.agent_state.as_deref(), Some("done" | "notice"))
        {
            self.agent_state = Some("idle".into());
            self.sequence += 1;
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
            let chunks = self
                .chunks
                .iter()
                .filter(|(sequence, _)| after.is_some_and(|cursor| *sequence > cursor));
            // Reserve once and copy whole chunks instead of growing the buffer byte by byte.
            // 一次预分配并整块复制，避免逐字节扩充缓冲区。
            let length = chunks.clone().map(|(_, data)| data.len()).sum();
            let mut data = Vec::with_capacity(length);
            for (_, chunk) in chunks {
                data.extend_from_slice(chunk);
            }
            data
        };
        Frame {
            agent_activity_error: self.activity_error.clone(),
            agent_events: Some(if reset {
                vec![]
            } else {
                self.activity_events
                    .iter()
                    .filter(|event| after.is_some_and(|cursor| event.sequence > cursor))
                    .cloned()
                    .collect()
            }),
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
        if self.task_log {
            // Task pipes retain the source bytes; replay them at the current width without grid cropping.
            // 任务管道保留原始字节，按当前宽度回放，避免网格裁剪。
            let mut data = b"\x1bc".to_vec();
            for (_, chunk) in &self.chunks {
                data.extend_from_slice(chunk);
            }
            return data;
        }
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
    task: Option<crate::tasks::TaskInfo>,
    spec: SessionSpec,
    generation: String,
    session: Arc<Session>,
    output: Arc<(Mutex<Output>, Condvar)>,
    activity_stopped: AtomicBool,
    activity: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl Entry {
    fn task_snapshot(&self) -> Option<TaskSession> {
        let task = self.task.clone()?;
        let output = lock(&self.output.0);
        Some(TaskSession {
            spec: self.spec.clone(),
            generation: self.generation.clone(),
            task,
            running: !output.exited,
            code: output.code,
        })
    }

    fn stop_activity(&self) -> Result<()> {
        self.activity_stopped.store(true, Ordering::Release);
        let task = lock(&self.activity).take();
        if let Some(task) = task {
            task.join()
                .map_err(|_| anyhow::anyhow!("Agent 事件服务停止失败。"))?;
        }
        Ok(())
    }
}
struct Host {
    directory: PathBuf,
    opening: Mutex<()>,
    sessions: Mutex<HashMap<String, Arc<Entry>>>,
    closed_sessions: Mutex<HashSet<String>>,
    stopping: Arc<AtomicBool>,
    processes: Mutex<ProcessCache>,
}

#[derive(Default)]
struct ProcessCache {
    refreshed: Option<Instant>,
    entries: HashMap<u32, crate::process::ProcessEntry>,
}

impl Host {
    fn prune_task_history(&self) {
        // Retain finished tasks for replay, without pruning ordinary terminal sessions.
        // 保留已完成任务以供回放，且不裁剪普通终端会话。
        let mut completed: Vec<_> = lock(&self.sessions)
            .values()
            .filter_map(|entry| {
                let task = entry.task.as_ref()?;
                lock(&entry.output.0)
                    .exited
                    .then(|| (task.created, entry.spec.id.clone()))
            })
            .collect();
        if completed.len() <= MAX_COMPLETED_TASKS {
            return;
        }
        completed.sort();
        let remove = completed.len() - MAX_COMPLETED_TASKS;
        let mut sessions = lock(&self.sessions);
        for (_, id) in completed.into_iter().take(remove) {
            sessions.remove(&id);
        }
    }

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

    fn open_session(
        &self,
        spec: SessionSpec,
        rows: u16,
        cols: u16,
        create: bool,
        configured: Option<(
            crate::ssh::ResolvedTarget,
            Option<crate::ssh_askpass::Endpoint>,
        )>,
        task: Option<(crate::tasks::TaskInfo, crate::tasks::Launch)>,
    ) -> Result<Arc<Entry>> {
        crate::size(rows, cols)?;
        if spec.id.is_empty() || spec.id.len() > 200 {
            bail!("Invalid session identifier");
        }
        // Serialize creation without holding up I/O for already-running sessions.
        // 串行创建会话，同时避免阻塞已有会话的 I/O。
        let _opening = lock(&self.opening);
        let sessions = lock(&self.sessions);
        if self.stopping.load(Ordering::Acquire) {
            bail!("Session host is restarting; reconnect before opening a session");
        }
        if let Some(entry) = sessions.get(&spec.id) {
            if entry.task.is_some() || task.is_some() {
                bail!("JAVA_TASK_ATTACH_ONLY");
            }
            if entry.spec != spec {
                bail!("Session configuration differs from its running process");
            }
            return Ok(entry.clone());
        }
        if !create {
            bail!("SSH_SESSION_MISSING");
        }
        if let Some((info, launch)) = &task {
            launch.validate()?;
            if spec.ssh.is_some()
                || spec.agent.is_some()
                || info.root != launch.root
                || spec.directory != info.root
            {
                bail!("JAVA_TASK_INVALID");
            }
            if sessions.values().any(|entry| {
                entry
                    .task
                    .as_ref()
                    .is_some_and(|value| value.root == info.root)
                    && !lock(&entry.output.0).exited
            }) {
                bail!("JAVA_TASK_RUNNING");
            }
        }
        if let Some(target) = &spec.ssh {
            target.validate()?;
            if spec.agent.is_some() {
                bail!("SSH_INVALID_CONNECTION");
            }
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
        drop(sessions);
        let output = Arc::new((
            Mutex::new(Output::new(rows, cols, spec.agent.as_deref())),
            Condvar::new(),
        ));
        let sink = output.clone();
        let (reply_sender, reply_receiver) = mpsc::sync_channel::<Vec<u8>>(64);
        let generation = uuid::Uuid::new_v4().to_string();
        let mut observer = None;
        let mut environment = vec![];
        let mut activity_error = None;
        let task_info = task.as_ref().map(|(info, _)| info.clone());
        let capture = if task_info.is_some() {
            let sink = output.clone();
            Some(crate::task_output::Capture::start(move |data| {
                let mut output = lock(&sink.0);
                output.task_log = true;
                output.record(Event::Output { sequence: 0, data });
                output.parser.callbacks_mut().bytes.clear();
                drop(output);
                sink.1.notify_all();
                Ok(())
            })?)
        } else {
            None
        };
        let captured = capture.as_ref().map(|capture| capture.connected.clone());
        let mut command = if let Some((_, launch)) = task {
            crate::tasks::command(&self.directory, launch)?
        } else if let Some(target) = &spec.ssh {
            crate::ssh::configured_command(
                target,
                configured.as_ref().map(|v| &v.0),
                configured.as_ref().and_then(|v| v.1.as_ref()),
            )?
        } else if let Some(agent) = spec.agent.as_deref() {
            let configuration = self
                .directory
                .parent()
                .context("Host directory has no parent")?;
            let (program, arguments) = crate::agents::resolve(configuration, agent)?;
            let arguments = match crate::activity_bridge::prepare(
                agent,
                &program,
                arguments.clone(),
                &spec.directory,
                &self.directory,
            ) {
                Ok(launch) => {
                    observer = launch.observer;
                    environment = launch.environment;
                    launch.arguments
                }
                Err(error) => {
                    activity_error = Some(format!("Agent 事件不可用，仍可接收终端提醒：{error}"));
                    arguments
                }
            };
            crate::process::launch_resolved(&program, &arguments)?
        } else {
            crate::process::launch_command(
                &spec.shell,
                spec.agent.as_deref(),
                self.directory
                    .parent()
                    .context("Host directory has no parent")?,
            )?
        };
        for (key, value) in environment {
            command.env(key, value);
        }
        if let Some(capture) = &capture {
            capture.configure(&mut command);
        }
        let capture = Mutex::new(capture);
        lock(&output.0).activity_error = activity_error;
        if spec.ssh.is_none() {
            command.env("UTERM_DESKTOP_HOST", &self.directory);
            command.env("UTERM_DESKTOP_REPORTER", std::env::current_exe()?);
            command.env("UTERM_DESKTOP_SESSION", &spec.id);
            command.env("UTERM_DESKTOP_GENERATION", &generation);
        }
        let session =
            Session::spawn_background(command, &spec.directory, rows, cols, move |event| {
                if matches!(&event, Event::Output { .. })
                    && captured
                        .as_ref()
                        .is_some_and(|connected| connected.load(Ordering::Acquire))
                {
                    return Ok(());
                }
                if matches!(&event, Event::Exit { .. }) {
                    if let Some(capture) = lock(&capture).take() {
                        if let Err(error) = capture.finish() {
                            lock(&sink.0).record(Event::Error {
                                message: format!(
                                    "任务日志读取失败，请停止任务后重新运行。 {error}"
                                ),
                            });
                        }
                    }
                }
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
            task: task_info,
            activity_stopped: AtomicBool::new(false),
            activity: Mutex::new(None),
            spec,
            generation,
            session,
            output,
        });
        lock(&self.sessions).insert(entry.spec.id.clone(), entry.clone());
        if let Some(observer) = observer {
            let alive = Arc::downgrade(&entry);
            let sink = Arc::downgrade(&entry);
            let errors = Arc::downgrade(&entry);
            let hints = Arc::downgrade(&entry);
            let task = std::thread::spawn(move || {
                crate::activity_bridge::observe(
                    observer,
                    move || {
                        alive.upgrade().is_some_and(|entry| {
                            !entry.activity_stopped.load(Ordering::Acquire)
                                && !entry.session.has_exited()
                        })
                    },
                    move || {
                        hints
                            .upgrade()
                            .is_some_and(|entry| lock(&entry.output.0).pending_notice.is_some())
                    },
                    move |kind| {
                        if let Some(entry) = sink.upgrade() {
                            let mut output = lock(&entry.output.0);
                            if !output.exited
                                && (kind == "done" || output.agent_state.as_deref() != Some(kind))
                            {
                                output.activity(kind, "events");
                                entry.output.1.notify_all();
                            }
                        }
                    },
                    move |error| {
                        if let Some(entry) = errors.upgrade() {
                            let mut output = lock(&entry.output.0);
                            output.structured_activity = error.is_none();
                            if output.activity_error != error {
                                output.activity_error = error;
                                output.sequence += 1;
                                entry.output.1.notify_all();
                            }
                        }
                    },
                );
            });
            *lock(&entry.activity) = Some(task);
        }
        Ok(entry)
    }

    fn dispatch(&self, operation: Operation) -> Result<Reply> {
        match operation {
            Operation::ClaimTask { id } => Ok(Reply::TaskLaunch(crate::tasks::take(&id)?)),
            Operation::TaskSnapshot => Ok(Reply::Tasks(
                lock(&self.sessions)
                    .values()
                    .filter_map(|entry| entry.task_snapshot())
                    .collect(),
            )),
            Operation::OpenTask {
                spec,
                task,
                launch,
                rows,
                cols,
            } => {
                self.prune_task_history();
                let entry =
                    self.open_session(spec, rows, cols, true, None, Some((task, launch)))?;
                Ok(Reply::Opened {
                    generation: entry.generation.clone(),
                })
            }
            Operation::Attach { id, rows, cols } => {
                crate::size(rows, cols)?;
                let entry = lock(&self.sessions)
                    .get(&id)
                    .cloned()
                    .context("JAVA_TASK_MISSING")?;
                if entry.task.is_none() {
                    bail!("JAVA_TASK_INVALID");
                }
                Ok(Reply::Opened {
                    generation: entry.generation.clone(),
                })
            }
            Operation::StopTask {
                id,
                generation,
                force,
            } => {
                let entry = self.entry(&id, &generation)?;
                if entry.task.is_none() {
                    bail!("JAVA_TASK_INVALID");
                }
                if !lock(&entry.output.0).exited {
                    if force {
                        entry.session.close()?;
                    } else {
                        entry.session.write(vec![3])?;
                    }
                }
                Ok(Reply::Done)
            }
            Operation::AcknowledgeAgentEvent {
                id,
                generation,
                event,
            } => {
                let entry = self.entry(&id, &generation)?;
                lock(&entry.output.0).acknowledge_activity(Some(&event));
                entry.output.1.notify_all();
                Ok(Reply::Done)
            }
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
                if state == "idle" {
                    output.acknowledge_activity(None);
                }
                if !output.exited
                    && !output.structured_activity
                    && output.agent_state.as_ref() != Some(&state)
                {
                    output.activity(&state, "hook");
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
                        "agent-events-v1".into(),
                        "ssh-sessions-v1".into(),
                        "ssh-options-v1".into(),
                        "ssh-jump-v1".into(),
                        "local-session-list-v1".into(),
                        "local-session-snapshot-v1".into(),
                        "local-host-management-v1".into(),
                        "java-tasks-v1".into(),
                        "task-pipe-output-v1".into(),
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
                let _opening = lock(&self.opening);
                let sessions = lock(&self.sessions);
                if sessions.values().any(|entry| !lock(&entry.output.0).exited) {
                    bail!("Sessions are still running; restart cancelled");
                }
                for entry in sessions.values() {
                    entry.stop_activity()?;
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
                            entry.spec.ssh.is_none()
                                && entry.task.is_none()
                                && !lock(&entry.output.0).exited
                                && !closed.contains(&entry.spec.id)
                        })
                        .map(|entry| entry.spec.clone())
                        .collect(),
                    closed: closed.iter().cloned().collect(),
                }))
            }
            Operation::ListSessions => Ok(Reply::Sessions(
                lock(&self.sessions)
                    .values()
                    .filter(|entry| {
                        entry.spec.ssh.is_none()
                            && entry.task.is_none()
                            && !lock(&entry.output.0).exited
                    })
                    .map(|entry| entry.spec.clone())
                    .collect(),
            )),
            Operation::Open { spec, rows, cols } => {
                if spec.ssh.is_some() {
                    bail!("Use OpenSsh for SSH sessions");
                }
                let entry = self.open_session(spec, rows, cols, true, None, None)?;
                Ok(Reply::Opened {
                    generation: entry.generation.clone(),
                })
            }
            Operation::OpenSshConfigured {
                spec,
                rows,
                cols,
                resolved,
                askpass,
            } => {
                if spec.ssh.is_none() {
                    bail!("SSH_INVALID_CONNECTION");
                }
                let entry =
                    self.open_session(spec, rows, cols, true, Some((resolved, askpass)), None)?;
                Ok(Reply::Opened {
                    generation: entry.generation.clone(),
                })
            }
            Operation::SshSessionSnapshot => Ok(Reply::SshSessionSnapshot(SessionSnapshot {
                sessions: lock(&self.sessions)
                    .values()
                    .filter(|entry| entry.spec.ssh.is_some())
                    .map(|entry| entry.spec.clone())
                    .collect(),
                closed: lock(&self.closed_sessions).iter().cloned().collect(),
            })),
            Operation::OpenSsh {
                spec,
                rows,
                cols,
                create,
            } => {
                if spec.ssh.is_none() {
                    bail!("SSH_INVALID_CONNECTION");
                }
                let entry = self.open_session(spec, rows, cols, create, None, None)?;
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
                if entry.spec.agent.is_none() && entry.spec.ssh.is_none() {
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
                let mut output = lock(&entry.output.0);
                output.flush_notice();
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
                let mut output = output;
                output.flush_notice();
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
                    let entry = sessions.remove(&id);
                    drop(sessions);
                    if let Some(entry) = entry {
                        entry.stop_activity()?;
                    }
                }
                Ok(Reply::Done)
            }
            Operation::ShutdownIfEmpty => {
                let _opening = lock(&self.opening);
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
        opening: Mutex::new(()),
        sessions: Mutex::new(HashMap::new()),
        closed_sessions: Mutex::new(HashSet::new()),
        stopping: Arc::new(AtomicBool::new(false)),
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
    fn slow_agent_startup_keeps_host_requests_responsive() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/startup-test")
            .join(uuid::Uuid::new_v4().to_string());
        let directory = root.join("host");
        std::fs::create_dir_all(&directory).unwrap();
        let ready = root.join("ready");
        #[cfg(windows)]
        let program = {
            let path = root.join("codex.cmd");
            std::fs::write(&path, "@echo off\r\nif \"%1\"==\"--help\" (\r\n echo ready>\"%~dp0ready\"\r\n ping -n 6 127.0.0.1 >nul\r\n)\r\nexit /b 0\r\n").unwrap();
            path
        };
        #[cfg(unix)]
        let program = {
            use std::os::unix::fs::PermissionsExt;
            let path = root.join("codex");
            std::fs::write(
                &path,
                "#!/bin/sh\nif [ \"$1\" = --help ]; then\n : > \"${0%/*}/ready\"\n sleep 5\nfi\n",
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            path
        };
        std::fs::write(
            root.join("agents.json"),
            serde_json::to_vec(&vec![crate::agents::AgentDefinition {
                id: "codex".into(),
                name: "Codex".into(),
                program: program.to_string_lossy().into(),
                arguments: vec![],
            }])
            .unwrap(),
        )
        .unwrap();
        let host = Arc::new(Host {
            directory,
            opening: Mutex::new(()),
            sessions: Mutex::new(HashMap::new()),
            closed_sessions: Mutex::new(HashSet::new()),
            stopping: Arc::new(AtomicBool::new(false)),
            processes: Mutex::new(ProcessCache::default()),
        });
        let starting = host.clone();
        let work = root.clone();
        let task = std::thread::spawn(move || {
            starting.open_session(
                SessionSpec {
                    id: "slow".into(),
                    directory: work,
                    shell: "default".into(),
                    agent: Some("codex".into()),
                    ssh: None,
                },
                24,
                80,
                true,
                None,
                None,
            )
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() {
            assert!(Instant::now() < deadline, "CLI probe did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        let reading = host.clone();
        let (sent, received) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            sent.send(reading.dispatch(Operation::HostStatus).is_ok())
                .unwrap();
        });
        let responsive = received.recv_timeout(Duration::from_secs(1));
        let entry = task.join().unwrap().unwrap();
        host.dispatch(Operation::Close {
            id: "slow".into(),
            generation: entry.generation.clone(),
        })
        .unwrap();
        reader.join().unwrap();
        assert_eq!(responsive.ok(), Some(true));
    }

    #[test]
    fn every_builtin_agent_receives_distinct_terminal_events_without_replaying_them() {
        for agent in crate::agents::BUILTIN_AGENTS {
            let mut output = Output::new(24, 80, Some(agent));
            for _ in 0..2 {
                let cursor = output.sequence;
                let data = b"\x1b]777;notify;Agent;Ready\x07".to_vec();
                output.record(Event::Output {
                    sequence: 0,
                    data: data.clone(),
                });
                output.pending_notice = Some(Instant::now() - Duration::from_secs(1));
                output.flush_notice();
                let frame = output.frame(Some(cursor));
                assert_eq!(frame.data, data, "{agent}");
                let events = frame.agent_events.unwrap();
                assert_eq!(events.len(), 1);
                assert_eq!(events[0].kind, "notice");
                assert_eq!(frame.agent_state.as_deref(), Some("notice"));
                assert!(output.frame(None).agent_events.unwrap().is_empty());
                assert!(output
                    .frame(Some(output.sequence))
                    .agent_events
                    .unwrap()
                    .is_empty());
            }
        }
    }

    #[test]
    fn structured_or_hook_activity_suppresses_duplicate_terminal_notifications() {
        let mut output = Output::new(24, 80, Some("claude"));
        output.record(Event::Output {
            sequence: 0,
            data: vec![7],
        });
        output.activity("done", "hook");
        output.flush_notice();
        assert_eq!(output.activity_events.len(), 1);
        output.structured_activity = true;
        output.record(Event::Output {
            sequence: 0,
            data: vec![7],
        });
        output.flush_notice();
        assert!(output.pending_notice.is_none());
        output.activity("done", "events");
        assert_eq!(output.activity_events.len(), 2);
        assert_ne!(output.activity_events[0].id, output.activity_events[1].id);
    }

    #[test]
    fn old_acknowledgements_cannot_clear_new_completions_and_crashes_still_notify() {
        let mut output = Output::new(24, 80, Some("codex"));
        output.activity("done", "events");
        let old = output.activity_events.back().unwrap().id.clone();
        output.activity("done", "events");
        output.acknowledge_activity(Some(&old));
        assert_eq!(output.agent_state.as_deref(), Some("done"));
        let latest = output.activity_events.back().unwrap().id.clone();
        output.acknowledge_activity(Some(&latest));
        assert_eq!(output.agent_state.as_deref(), Some("idle"));
        output.activity("waiting", "events");
        output.record(Event::Exit { code: Some(1) });
        assert_eq!(output.activity_events.back().unwrap().source, "process");
        assert_eq!(output.activity_events.back().unwrap().kind, "error");
    }

    #[test]
    fn structured_observers_retain_a_delayed_generic_fallback_when_no_precise_event_arrives() {
        let mut output = Output::new(24, 80, Some("codex"));
        output.structured_activity = true;
        output.record(Event::Output {
            sequence: 0,
            data: b"\x1b]9;Ready\x07".to_vec(),
        });
        output.pending_notice = Some(Instant::now() - Duration::from_secs(2));
        output.flush_notice();
        assert_eq!(output.activity_events.back().unwrap().kind, "notice");
    }

    #[test]
    fn delta_frames_preserve_bytes_order_and_exit_metadata() {
        let mut output = Output::new(24, 80, None);
        output.record(Event::Output {
            sequence: 1,
            data: b"already consumed".to_vec(),
        });
        let bytes: Vec<u8> = (0..=255).collect();
        for chunk in bytes.chunks(31) {
            output.record(Event::Output {
                sequence: 0,
                data: chunk.to_vec(),
            });
        }
        output.record(Event::Output {
            sequence: 0,
            data: vec![],
        });
        output.record(Event::Exit { code: Some(7) });

        let frame = output.frame(Some(1));
        assert_eq!(frame.data, bytes);
        assert!(!frame.reset);
        assert!(frame.exited);
        assert_eq!(frame.code, Some(7));
        assert_eq!((frame.rows, frame.cols), (24, 80));
        assert_eq!(frame.sequence, output.sequence);
        assert!(output.frame(Some(frame.sequence)).data.is_empty());
    }

    #[test]
    fn evicted_and_future_cursors_still_request_a_replay_reset() {
        let mut output = Output::new(24, 80, None);
        output.record(Event::Output {
            sequence: 1,
            data: b"old".to_vec(),
        });
        output.record(Event::Output {
            sequence: 2,
            data: vec![b'x'; HISTORY_BYTES],
        });
        assert!(output.frame(Some(0)).reset);
        assert!(output.frame(Some(u64::MAX)).reset);
        let delta = output.frame(Some(1));
        assert!(!delta.reset);
        assert_eq!(delta.data.len(), HISTORY_BYTES);
        assert!(delta.data.iter().all(|byte| *byte == b'x'));
    }

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

    #[test]
    fn long_log_lines_survive_narrowing_and_reopening() {
        let mut output = Output::new(24, 200, None);
        output.task_log = true;
        let line = format!("Starting {} tail-marker 中文\r\n", "x".repeat(140));
        output.record(Event::Output {
            sequence: 0,
            data: line.as_bytes().to_vec(),
        });
        output.parser.screen_mut().set_size(24, 100);
        output.parser.screen_mut().set_size(24, 200);
        let frame = output.frame(None);
        assert!(String::from_utf8_lossy(&frame.data).contains("tail-marker"));
    }

    #[test]
    fn task_log_replay_preserves_unicode_ansi_and_newlines_across_chunks() {
        let mut output = Output::new(4, 20, None);
        output.task_log = true;
        let source = "\x1b[32m完整日志\x1b[0m\r\nsecond\nthird\r\n";
        for byte in source.as_bytes() {
            output.record(Event::Output {
                sequence: 0,
                data: vec![*byte],
            });
        }
        let expected = "\x1bc\x1b[32m完整日志\x1b[0m\r\nsecond\r\nthird\r\n";
        assert_eq!(output.frame(None).data, expected.as_bytes());
        output.parser.screen_mut().set_size(2, 5);
        assert_eq!(output.frame(None).data, expected.as_bytes());
        assert!(output.frame(Some(output.sequence)).data.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn background_host_breaks_away_from_the_parent_job() {
        assert_ne!(BACKGROUND_PROCESS_FLAGS & CREATE_BREAKAWAY_FROM_JOB, 0);
    }
}
