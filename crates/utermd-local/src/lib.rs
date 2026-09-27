//! Local PTYs and the independent cross-platform desktop session host.

pub mod agents;
pub mod daemon;

mod process;
pub use process::{agent_program, shell_command};

use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

const CHUNK_SIZE: usize = 16 * 1024;
const POLL: Duration = Duration::from_millis(25);

#[derive(Debug)]
pub enum Event {
    Output { sequence: u64, data: Vec<u8> },
    Exit { code: Option<u32> },
    Error { message: String },
}

type Sink = Arc<dyn Fn(Event) -> Result<()> + Send + Sync>;
type Input = (Vec<u8>, mpsc::SyncSender<Result<(), String>>);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| {
        eprintln!("utermd-local: recovering a poisoned session lock");
        poisoned.into_inner()
    })
}

fn size(rows: u16, cols: u16) -> Result<PtySize> {
    if rows == 0 || cols == 0 || rows > 1000 || cols > 1000 {
        bail!("Terminal dimensions must be between 1 and 1000");
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

struct Control {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    group: process::ProcessGroup,
    input: Mutex<Option<mpsc::SyncSender<Input>>>,
    auto_acknowledge: bool,
    closing: AtomicBool,
    finished: AtomicBool,
    exit_code: Mutex<Option<u32>>,
    pending: Mutex<Option<u64>>,
    acknowledged: Condvar,
}

impl Control {
    fn close(&self) -> Result<()> {
        self.closing.store(true, Ordering::Release);
        self.acknowledged.notify_all();
        lock(&self.input).take();
        let mut child = lock(&self.child);
        let master = lock(&self.master);
        self.group.terminate(
            child.as_mut(),
            master.as_deref().map(|value| value as &dyn MasterPty),
        )
    }

    fn fail(&self, sink: &Sink, error: impl std::fmt::Display) {
        let message = error.to_string();
        eprintln!("utermd-local: {message}");
        if let Err(error) = sink(Event::Error { message }) {
            eprintln!("utermd-local: could not report session error: {error}");
        }
        if let Err(error) = self.close() {
            eprintln!("utermd-local: could not close failed session: {error}");
        }
    }
}

pub struct Session {
    control: Arc<Control>,
    process_id: Option<u32>,
}

impl Session {
    pub(crate) fn process_id(&self) -> Option<u32> {
        self.process_id
    }

    pub fn spawn(
        command: CommandBuilder,
        directory: &Path,
        rows: u16,
        cols: u16,
        sink: impl Fn(Event) -> Result<()> + Send + Sync + 'static,
    ) -> Result<Self> {
        Self::spawn_with_flow(command, directory, rows, cols, sink, false)
    }

    pub fn spawn_background(
        command: CommandBuilder,
        directory: &Path,
        rows: u16,
        cols: u16,
        sink: impl Fn(Event) -> Result<()> + Send + Sync + 'static,
    ) -> Result<Self> {
        Self::spawn_with_flow(command, directory, rows, cols, sink, true)
    }

    fn spawn_with_flow(
        mut command: CommandBuilder,
        directory: &Path,
        rows: u16,
        cols: u16,
        sink: impl Fn(Event) -> Result<()> + Send + Sync + 'static,
        auto_acknowledge: bool,
    ) -> Result<Self> {
        let dimensions = size(rows, cols)?;
        if !directory.is_absolute() || !directory.is_dir() {
            bail!("Working directory must be an existing absolute directory");
        }
        let directory = directory
            .canonicalize()
            .context("resolving working directory")?;
        command.cwd(command_working_directory(directory));
        let pair = native_pty_system()
            .openpty(dimensions)
            .context("opening PTY")?;
        let reader = pair
            .master
            .try_clone_reader()
            .context("opening PTY reader")?;
        let writer = pair.master.take_writer().context("opening PTY writer")?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .context("starting shell")?;
        let process_id = child.process_id();
        drop(pair.slave);
        let group = match process::ProcessGroup::attach(child.as_ref()) {
            Ok(group) => group,
            Err(error) => {
                if let Err(cleanup) = child.kill() {
                    eprintln!("utermd-local: {cleanup}");
                }
                if let Err(cleanup) = child.wait() {
                    eprintln!("utermd-local: {cleanup}");
                }
                return Err(error);
            }
        };
        let (sender, receiver) = mpsc::sync_channel(16);
        let control = Arc::new(Control {
            master: Mutex::new(Some(pair.master)),
            child: Mutex::new(child),
            group,
            input: Mutex::new(Some(sender)),
            auto_acknowledge,
            closing: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            exit_code: Mutex::new(None),
            pending: Mutex::new(None),
            acknowledged: Condvar::new(),
        });
        let session = Self {
            control: control.clone(),
            process_id,
        };
        let sink: Sink = Arc::new(sink);
        let waiter = control.clone();
        let wait_sink = sink.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("local-pty-wait".into())
            .spawn(move || {
                loop {
                    let status = lock(&waiter.child).try_wait();
                    match status {
                        Ok(Some(status)) => {
                            *lock(&waiter.exit_code) = Some(status.exit_code());
                            break;
                        }
                        Ok(None) => std::thread::sleep(POLL),
                        Err(error) => {
                            waiter.fail(&wait_sink, error);
                            break;
                        }
                    }
                }
                waiter.finished.store(true, Ordering::Release);
                lock(&waiter.input).take();
                // Close ConPTY on a worker while the reader continues draining its pipe.
                // ClosePseudoConsole can block until that output has been consumed.
                let master = lock(&waiter.master).take();
                drop(master);
            })
        {
            session.close()?;
            lock(&control.child)
                .wait()
                .context("reaping shell after worker failure")?;
            return Err(error.into());
        }
        let writer_control = control.clone();
        let writer_sink = sink.clone();
        std::thread::Builder::new()
            .name("local-pty-input".into())
            .spawn(move || {
                write_input(writer, receiver, writer_control, writer_sink);
            })?;
        std::thread::Builder::new()
            .name("local-pty-output".into())
            .spawn(move || {
                read_output(reader, control, sink);
            })?;
        Ok(session)
    }

    pub fn write(&self, data: Vec<u8>) -> Result<()> {
        if data.is_empty() || data.len() > CHUNK_SIZE {
            bail!("Invalid input size");
        }
        if self.control.closing.load(Ordering::Acquire) {
            bail!("Session is closed");
        }
        let sender = lock(&self.control.input)
            .clone()
            .context("Session has exited")?;
        let (done, result) = mpsc::sync_channel(1);
        sender
            .try_send((data, done))
            .map_err(|error| anyhow::anyhow!("Input queue unavailable: {error}"))?;
        result
            .recv()
            .context("Input worker stopped")?
            .map_err(anyhow::Error::msg)
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        let dimensions = size(rows, cols)?;
        let master = lock(&self.control.master);
        master
            .as_ref()
            .context("Session has exited")?
            .resize(dimensions)
    }

    pub fn acknowledge(&self, sequence: u64) {
        let mut pending = lock(&self.control.pending);
        if *pending == Some(sequence) {
            *pending = None;
            self.control.acknowledged.notify_all();
        }
    }

    pub fn close(&self) -> Result<()> {
        self.control.close()
    }
    pub fn has_exited(&self) -> bool {
        self.control.finished.load(Ordering::Acquire)
    }
}

fn command_working_directory(directory: std::path::PathBuf) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let path: Vec<_> = directory.as_os_str().encode_wide().collect();
        let has_verbatim_drive_prefix = path.len() >= 6
            && path[..4] == [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16]
            && ((b'A' as u16..=b'Z' as u16).contains(&path[4])
                || (b'a' as u16..=b'z' as u16).contains(&path[4]))
            && path[5] == b':' as u16;
        if has_verbatim_drive_prefix {
            // cmd.exe treats a verbatim path as a UNC directory and starts in
            // C:\\Windows instead. Local drive paths do not need this prefix.
            return std::path::PathBuf::from(OsString::from_wide(&path[4..]));
        }
    }
    directory
}

#[cfg(all(test, windows))]
mod tests {
    use super::command_working_directory;
    use std::path::PathBuf;

    #[test]
    fn command_working_directory_removes_a_verbatim_local_drive_prefix() {
        let directory = PathBuf::from(r"\\?\D:\TRAE_WORKSPACE\GitHub\StudyEnglish");

        assert_eq!(
            command_working_directory(directory),
            PathBuf::from(r"D:\TRAE_WORKSPACE\GitHub\StudyEnglish")
        );
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Err(error) = self.close() {
            eprintln!("utermd-local: close failed: {error}");
        }
    }
}

fn write_input(
    mut writer: Box<dyn Write + Send>,
    receiver: mpsc::Receiver<Input>,
    control: Arc<Control>,
    sink: Sink,
) {
    while let Ok((data, done)) = receiver.recv() {
        let result = if control.closing.load(Ordering::Acquire) {
            Err("Session is closed".to_owned())
        } else {
            writer
                .write_all(&data)
                .and_then(|_| writer.flush())
                .map_err(|error| error.to_string())
        };
        let failure = result.as_ref().err().cloned();
        if done.send(result).is_err() {
            eprintln!("utermd-local: input caller disconnected");
        }
        if let Some(error) = failure {
            if !control.closing.load(Ordering::Acquire) {
                control.fail(&sink, error);
            }
            break;
        }
    }
}

fn read_output(mut reader: Box<dyn Read + Send>, control: Arc<Control>, sink: Sink) {
    let mut buffer = [0u8; CHUNK_SIZE];
    let mut sequence = 0;
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            // Unix PTYs can signal EOF as EIO after the slave closes.
            #[cfg(unix)]
            Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
            Err(error) => {
                if !control.closing.load(Ordering::Acquire) {
                    control.fail(&sink, error);
                }
                break;
            }
        };
        if control.closing.load(Ordering::Acquire) {
            continue;
        }
        sequence += 1;
        *lock(&control.pending) = Some(sequence);
        if let Err(error) = sink(Event::Output {
            sequence,
            data: buffer[..count].to_vec(),
        }) {
            control.fail(&sink, error);
            continue;
        }
        if control.auto_acknowledge {
            continue;
        }
        let mut pending = lock(&control.pending);
        while pending.is_some() && !control.closing.load(Ordering::Acquire) {
            pending = control
                .acknowledged
                .wait_timeout(pending, POLL)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }
    while !control.finished.load(Ordering::Acquire) {
        std::thread::sleep(POLL);
    }
    if let Err(error) = sink(Event::Exit {
        code: *lock(&control.exit_code),
    }) {
        eprintln!("utermd-local: could not report exit: {error}");
    }
}
