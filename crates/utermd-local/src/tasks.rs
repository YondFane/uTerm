use anyhow::{bail, Context, Result};
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_TASK_STEPS: usize = 3;
const MAX_ARGUMENTS: usize = 256;
const MAX_VALUE_BYTES: usize = 32768;
const MAX_ENVIRONMENT_ENTRIES: usize = 128;
const MAX_ENVIRONMENT_KEY_BYTES: usize = 128;
const MAX_LABEL_BYTES: usize = 200;
const MAX_PENDING_LAUNCHES: usize = 128;
const LAUNCH_LIFETIME: Duration = Duration::from_secs(60);
static INTERRUPTED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
unsafe extern "system" fn task_interrupt(event: u32) -> i32 {
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT};
    if matches!(event, CTRL_C_EVENT | CTRL_BREAK_EVENT) {
        INTERRUPTED.store(true, Ordering::Release);
        return 1;
    }
    0
}

#[cfg(unix)]
extern "C" fn task_interrupt(_: libc::c_int) {
    INTERRUPTED.store(true, Ordering::Release);
}

#[cfg(windows)]
const CONSOLE_BRIDGE: &str = concat!(
    "$start = New-Object System.Diagnostics.ProcessStartInfo; ",
    "$start.FileName = $env:UTERM_TASK_EXECUTABLE; ",
    "$start.Arguments = '--local-task'; ",
    "$start.UseShellExecute = $false; ",
    "$child = [System.Diagnostics.Process]::Start($start); ",
    "$child.WaitForExit(); exit $child.ExitCode",
);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskInfo {
    pub root: PathBuf,
    pub name: String,
    pub action: String,
    pub created: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Step {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub directory: PathBuf,
    pub environment: HashMap<String, String>,
    pub label: String,
    #[serde(default)]
    pub jar_directory: Option<PathBuf>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Launch {
    pub root: PathBuf,
    pub steps: Vec<Step>,
}

impl Launch {
    pub fn validate(&self) -> Result<()> {
        if !self.root.is_absolute() || self.root.canonicalize()? != self.root {
            bail!("JAVA_PROJECT_INVALID");
        }
        if self.steps.is_empty() || self.steps.len() > MAX_TASK_STEPS {
            bail!("JAVA_TASK_INVALID");
        }
        for step in &self.steps {
            step.validate(&self.root)?;
        }
        Ok(())
    }
}

impl Step {
    fn validate(&self, root: &Path) -> Result<()> {
        if !self.program.is_absolute()
            || !self.program.is_file()
            || !self.directory.canonicalize()?.starts_with(root)
        {
            bail!("JAVA_TASK_INVALID");
        }
        if self.arguments.len() > MAX_ARGUMENTS
            || self.arguments.iter().any(|value| !valid_value(value))
        {
            bail!("JAVA_TASK_INVALID");
        }
        if self.environment.len() > MAX_ENVIRONMENT_ENTRIES
            || self.environment.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > MAX_ENVIRONMENT_KEY_BYTES
                    || key.to_ascii_uppercase().starts_with("UTERM_")
                    || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                    || !valid_value(value)
            })
        {
            bail!("JAVA_TASK_INVALID");
        }
        if self.label.len() > MAX_LABEL_BYTES || self.label.chars().any(char::is_control) {
            bail!("JAVA_TASK_INVALID");
        }
        Ok(())
    }

    fn resolve_jar(&mut self, root: &Path) -> Result<()> {
        let Some(directory) = &self.jar_directory else {
            return Ok(());
        };
        // Packaging creates the artifact, so resolve it only when this step is about to run.
        // 打包步骤会生成产物，因此只在即将运行当前步骤时解析 JAR。
        let jar = find_executable_jar(root, directory)?;
        let position = self
            .arguments
            .iter()
            .position(|value| value == "-jar")
            .context("JAVA_TASK_INVALID")?
            + 1;
        self.arguments.insert(position, java_path(&jar)?);
        Ok(())
    }
}

fn valid_value(value: &str) -> bool {
    value.len() <= MAX_VALUE_BYTES && !value.contains('\0')
}

struct Pending {
    launch: Launch,
    created: Instant,
}
static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();

pub(crate) fn take(id: &str) -> Result<Launch> {
    let mut pending = crate::lock(PENDING.get_or_init(Default::default));
    let entry = pending.remove(id).context("JAVA_TASK_EXPIRED")?;
    if entry.created.elapsed() > LAUNCH_LIFETIME {
        bail!("JAVA_TASK_EXPIRED");
    }
    Ok(entry.launch)
}

fn register_launch(launch: Launch) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut pending = crate::lock(PENDING.get_or_init(Default::default));
    pending.retain(|_, entry| entry.created.elapsed() < LAUNCH_LIFETIME);
    if pending.len() >= MAX_PENDING_LAUNCHES {
        bail!("JAVA_TASK_BUSY");
    }
    pending.insert(
        id.clone(),
        Pending {
            launch,
            created: Instant::now(),
        },
    );
    Ok(id)
}

pub(crate) fn command(directory: &Path, launch: Launch) -> Result<CommandBuilder> {
    launch.validate()?;
    let id = register_launch(launch)?;
    // Claim once over authenticated IPC; environment values never enter files or arguments.
    // 通过已认证 IPC 单次领取配置，环境变量值不写入文件或命令行参数。
    #[cfg(not(windows))]
    let mut command = {
        let mut command = CommandBuilder::new(std::env::current_exe()?);
        command.arg("--local-task");
        command.arg(directory);
        command.arg(&id);
        command
    };
    #[cfg(windows)]
    let mut command = {
        // A GUI-subsystem executable needs a console parent before it can attach to ConPTY.
        // GUI 子系统程序需要控制台父进程，才能附加到 ConPTY。
        let system = std::env::var_os("SystemRoot").context("JAVA_TASK_INVALID")?;
        let mut command = CommandBuilder::new(
            PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            CONSOLE_BRIDGE,
        ]);
        command
    };
    crate::process::sanitize_environment(&mut command);
    #[cfg(windows)]
    {
        command.env("UTERM_TASK_EXECUTABLE", std::env::current_exe()?);
        command.env("UTERM_TASK_ROOT", directory);
        command.env("UTERM_TASK_ID", id);
    }
    Ok(command)
}

fn step_command(step: &Step) -> Command {
    let mut command = Command::new(&step.program);
    command.args(&step.arguments);
    for key in [
        "UTERM_TASK_EXECUTABLE",
        "UTERM_TASK_ROOT",
        "UTERM_TASK_ID",
        crate::task_output::ADDRESS,
        crate::task_output::TOKEN,
    ] {
        command.env_remove(key);
    }
    command
}

fn java_path(path: &Path) -> Result<String> {
    let text = path.to_str().context("JAVA_PROJECT_INVALID")?;
    Ok(if let Some(value) = text.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{value}")
    } else {
        text.strip_prefix("\\\\?\\").unwrap_or(text).into()
    })
}

fn complete_utf8_length(bytes: &[u8]) -> usize {
    let mut offset = 0;
    while offset < bytes.len() {
        match std::str::from_utf8(&bytes[offset..]) {
            Ok(_) => return bytes.len(),
            Err(error) => {
                offset += error.valid_up_to();
                match error.error_len() {
                    Some(length) => offset += length,
                    None => return offset,
                }
            }
        }
    }
    bytes.len()
}

fn find_executable_jar(root: &Path, directory: &Path) -> Result<PathBuf> {
    let directory = directory.canonicalize()?;
    if !directory.starts_with(root) {
        bail!("JAVA_PROJECT_INVALID");
    }
    let jars: Vec<_> = std::fs::read_dir(directory)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.path().extension().is_some_and(|value| value == "jar")
                && ![
                    "-sources.jar",
                    "-javadoc.jar",
                    "-tests.jar",
                    ".original.jar",
                ]
                .iter()
                .any(|suffix| entry.file_name().to_string_lossy().ends_with(suffix))
        })
        .map(|entry| entry.path())
        .collect();
    match jars.as_slice() {
        [jar] => Ok(jar.clone()),
        _ => bail!("JAVA_JAR_AMBIGUOUS"),
    }
}

pub fn run(directory: &Path, id: &str) -> Result<i32> {
    let stream = crate::task_output::connect()?;
    let captured = stream.is_some();
    let output: Box<dyn std::io::Write + Send> = match stream {
        Some(stream) => Box::new(stream),
        None => Box::new(std::io::stdout()),
    };
    let output = std::sync::Arc::new(Mutex::new(output));
    let result = run_steps(directory, id, captured, output.clone());
    if let Err(error) = &result {
        use std::io::Write;
        writeln!(crate::lock(&output), "\r\n{error:#}\r")?;
    }
    result
}

fn run_steps(
    directory: &Path,
    id: &str,
    captured: bool,
    output: std::sync::Arc<Mutex<Box<dyn std::io::Write + Send>>>,
) -> Result<i32> {
    use std::io::Write;
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{
            AttachConsole, GetConsoleCP, SetConsoleCtrlHandler, SetConsoleOutputCP,
            ATTACH_PARENT_PROCESS,
        };
        if unsafe { GetConsoleCP() } == 0 && unsafe { AttachConsole(ATTACH_PARENT_PROCESS) } == 0 {
            return Err(std::io::Error::last_os_error()).context("JAVA_TASK_INVALID");
        }
        if captured && unsafe { SetConsoleOutputCP(65001) } == 0 {
            return Err(std::io::Error::last_os_error()).context("JAVA_TASK_OUTPUT_FAILED");
        }
        // Keep the runner alive while the child handles interruption; handlers are not inherited.
        // 子进程处理中断时保持执行器存活；此处理器不会被子进程继承。
        if unsafe { SetConsoleCtrlHandler(None, 0) } == 0
            || unsafe { SetConsoleCtrlHandler(Some(task_interrupt), 1) } == 0
        {
            return Err(std::io::Error::last_os_error()).context("JAVA_TASK_INVALID");
        }
    }
    #[cfg(unix)]
    unsafe {
        // A caught signal resets on exec, so children still receive their normal interrupt behavior.
        // 已捕获信号在 exec 时恢复默认设置，因此子进程仍按自身方式处理中断。
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = task_interrupt as *const () as usize;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        if libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut()) != 0 {
            return Err(std::io::Error::last_os_error()).context("JAVA_TASK_INVALID");
        }
    }
    use crate::daemon::{Client, Operation, Reply};
    let client = Client::connect(directory)?;
    client.require_task_support()?;
    let Reply::TaskLaunch(launch) = client.request(Operation::ClaimTask { id: id.into() })? else {
        bail!("JAVA_TASK_INVALID");
    };
    launch.validate()?;
    for mut step in launch.steps {
        if INTERRUPTED.load(Ordering::Acquire) {
            return Ok(130);
        }
        step.resolve_jar(&launch.root)?;
        writeln!(crate::lock(&output), "\r\n> {}\r", step.label)?;
        let mut command = step_command(&step);
        command
            .current_dir(&step.directory)
            .envs(&step.environment)
            .stdin(Stdio::inherit());
        // Capture process bytes before ConPTY wraps or redraws them during a panel resize.
        // 在 ConPTY 随面板尺寸换行或重绘之前采集进程字节。
        let status = if captured {
            let mut child = command
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;
            let stdout = child.stdout.take().context("JAVA_TASK_OUTPUT_FAILED")?;
            let stderr = child.stderr.take().context("JAVA_TASK_OUTPUT_FAILED")?;
            let forward = |mut reader: Box<dyn std::io::Read + Send>| {
                let output = output.clone();
                std::thread::spawn(move || -> std::io::Result<()> {
                    let mut buffer = [0; 16384];
                    let mut pending = Vec::new();
                    loop {
                        let count = reader.read(&mut buffer)?;
                        if count == 0 {
                            crate::lock(&output).write_all(&pending)?;
                            return Ok(());
                        }
                        pending.extend_from_slice(&buffer[..count]);
                        // Keep a split UTF-8 character together when stdout and stderr share the log.
                        // 标准输出与标准错误共用日志时，避免拆开的 UTF-8 字符交错。
                        let complete = complete_utf8_length(&pending);
                        crate::lock(&output).write_all(&pending[..complete])?;
                        pending.drain(..complete);
                    }
                })
            };
            let stdout = forward(Box::new(stdout));
            let stderr = forward(Box::new(stderr));
            let status = child.wait()?;
            let stdout = stdout
                .join()
                .map_err(|_| anyhow::anyhow!("JAVA_TASK_OUTPUT_FAILED"))?;
            let stderr = stderr
                .join()
                .map_err(|_| anyhow::anyhow!("JAVA_TASK_OUTPUT_FAILED"))?;
            stdout?;
            stderr?;
            status
        } else {
            command
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .status()?
        };
        if !status.success() {
            let code = status.code().unwrap_or(1);
            writeln!(crate::lock(&output), "Task failed (exit code {code}).\r")?;
            return Ok(code);
        }
        if INTERRUPTED.load(Ordering::Acquire) {
            return Ok(0);
        }
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forwarding_keeps_partial_unicode_out_of_other_streams() {
        let bytes = "ASCII中文🙂".as_bytes();
        for length in 0..=bytes.len() {
            let complete = complete_utf8_length(&bytes[..length]);
            assert!(std::str::from_utf8(&bytes[..complete]).is_ok());
            assert!(length - complete <= 3);
        }
        assert_eq!(complete_utf8_length(&[255, b'a', 0xe4]), 2);
    }

    #[test]
    fn launch_rejects_root_escape_and_control_environment() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        let mut launch = Launch {
            root: root.clone(),
            steps: vec![Step {
                program: std::env::current_exe().unwrap(),
                arguments: vec![],
                directory: root,
                environment: HashMap::new(),
                label: "Maven test".into(),
                jar_directory: None,
            }],
        };
        assert!(launch.validate().is_ok());
        launch.steps[0]
            .environment
            .insert("UTERM_DESKTOP_HOST".into(), "elsewhere".into());
        assert!(launch.validate().is_err());
        launch.steps[0].environment.clear();
        launch.steps[0].directory = std::env::temp_dir();
        assert!(launch.validate().is_err());
    }

    #[test]
    fn java_paths_remove_windows_extended_prefixes_for_boot_nested_jars() {
        assert_eq!(
            java_path(Path::new(r"\\?\D:\中文 & project\app.jar")).unwrap(),
            r"D:\中文 & project\app.jar"
        );
        assert_eq!(
            java_path(Path::new(r"\\?\UNC\server\share\app.jar")).unwrap(),
            r"\\server\share\app.jar"
        );
    }

    #[test]
    fn generated_jar_is_resolved_after_packaging_and_stays_inside_the_project() {
        let fixture = std::env::temp_dir().join(format!("uterm-jar-test-{}", uuid::Uuid::new_v4()));
        let project = fixture.join("project");
        let outside = fixture.join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let root = project.canonicalize().unwrap();
        let target = root.join("target");
        std::fs::create_dir(&target).unwrap();
        let mut step = Step {
            program: std::env::current_exe().unwrap(),
            arguments: vec!["-Xmx256m".into(), "-jar".into(), "--name=中文 & %".into()],
            directory: root.clone(),
            environment: HashMap::new(),
            label: "JAR run".into(),
            jar_directory: Some(target.clone()),
        };
        assert!(step.resolve_jar(&root).is_err());
        for name in [
            "app.jar",
            "app-sources.jar",
            "app-javadoc.jar",
            "app-tests.jar",
            "app.original.jar",
        ] {
            std::fs::write(target.join(name), "fixture").unwrap();
        }
        step.resolve_jar(&root).unwrap();
        assert_eq!(
            step.arguments[2],
            java_path(&target.join("app.jar")).unwrap()
        );
        assert_eq!(step.arguments[3], "--name=中文 & %");
        std::fs::write(target.join("another.jar"), "fixture").unwrap();
        assert!(find_executable_jar(&root, &target)
            .unwrap_err()
            .to_string()
            .contains("JAVA_JAR_AMBIGUOUS"));
        assert!(find_executable_jar(&root, &outside)
            .unwrap_err()
            .to_string()
            .contains("JAVA_PROJECT_INVALID"));
        std::fs::remove_dir_all(fixture).unwrap();
    }
}
