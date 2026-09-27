use anyhow::{bail, Context, Result};
use portable_pty::{Child, CommandBuilder, MasterPty};
use std::path::PathBuf;

#[cfg(windows)]
pub(crate) struct ProcessEntry {
    parent: u32,
    name: String,
}

#[cfg(windows)]
pub(crate) fn process_snapshot() -> Result<std::collections::HashMap<u32, ProcessEntry>> {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error()).context("reading process list");
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut process = PROCESSENTRY32W::default();
    process.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    if unsafe { Process32FirstW(handle, &mut process) } == 0 {
        return Err(std::io::Error::last_os_error()).context("reading first process");
    }
    let mut entries = std::collections::HashMap::new();
    loop {
        let end = process
            .szExeFile
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(process.szExeFile.len());
        entries.insert(
            process.th32ProcessID,
            ProcessEntry {
                parent: process.th32ParentProcessID,
                name: String::from_utf16_lossy(&process.szExeFile[..end]).to_ascii_lowercase(),
            },
        );
        if unsafe { Process32NextW(handle, &mut process) } == 0 {
            if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
                return Err(std::io::Error::last_os_error()).context("reading process list");
            }
            break;
        }
    }
    drop(snapshot);
    Ok(entries)
}

#[cfg(windows)]
pub(crate) fn agent_in_process_tree(
    shell: u32,
    processes: &std::collections::HashMap<u32, ProcessEntry>,
) -> Option<&'static str> {
    let mut closest = None;
    for (id, process) in processes {
        let agent = match process.name.as_str() {
            "codex.exe" => "codex",
            "claude.exe" => "claude",
            _ => continue,
        };
        let mut parent = process.parent;
        let mut depth = 1;
        while parent != shell && depth < 32 {
            if parent == *id {
                break;
            }
            let Some(ancestor) = processes.get(&parent) else {
                break;
            };
            parent = ancestor.parent;
            depth += 1;
        }
        if parent == shell {
            match closest {
                None => closest = Some((depth, agent, false)),
                Some((distance, _, _)) if depth < distance => {
                    closest = Some((depth, agent, false));
                }
                Some((distance, previous, _)) if depth == distance && previous != agent => {
                    closest = Some((depth, agent, true));
                }
                _ => {}
            }
        }
    }
    closest.and_then(|(_, agent, ambiguous)| (!ambiguous).then_some(agent))
}

#[cfg(all(test, windows))]
mod process_tests {
    use super::{agent_in_process_tree, process_snapshot, ProcessEntry};
    use std::collections::HashMap;

    #[test]
    fn agent_must_be_a_descendant_of_the_session_shell() {
        let processes = HashMap::from([
            (
                10,
                ProcessEntry {
                    parent: 1,
                    name: "powershell.exe".into(),
                },
            ),
            (
                11,
                ProcessEntry {
                    parent: 10,
                    name: "cmd.exe".into(),
                },
            ),
            (
                12,
                ProcessEntry {
                    parent: 11,
                    name: "codex.exe".into(),
                },
            ),
            (
                20,
                ProcessEntry {
                    parent: 1,
                    name: "claude.exe".into(),
                },
            ),
        ]);
        assert_eq!(agent_in_process_tree(10, &processes), Some("codex"));
        assert_eq!(agent_in_process_tree(30, &processes), None);
        let mut ambiguous = processes;
        ambiguous.insert(
            13,
            ProcessEntry {
                parent: 11,
                name: "claude.exe".into(),
            },
        );
        assert_eq!(agent_in_process_tree(10, &ambiguous), None);
    }

    #[test]
    fn process_snapshot_includes_the_current_process() {
        let processes = process_snapshot().expect("process snapshot");
        assert!(processes.contains_key(&std::process::id()));
    }
}

pub fn shell_command(shell: &str) -> Result<CommandBuilder> {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").context("SystemRoot is not set")?;
        let system = PathBuf::from(root).join("System32");
        let mut command = match shell {
            "default" | "powershell" => {
                let mut command =
                    CommandBuilder::new(system.join("WindowsPowerShell/v1.0/powershell.exe"));
                command.arg("-NoLogo");
                command
            }
            "cmd" => {
                let mut command = CommandBuilder::new(system.join("cmd.exe"));
                command.arg("/D");
                command
            }
            _ => bail!("Unsupported shell: {shell}"),
        };
        sanitize_environment(&mut command);
        Ok(command)
    }
    #[cfg(unix)]
    {
        if shell != "default" {
            bail!("Only the default login shell is supported on this platform");
        }
        let program = std::env::var_os("SHELL")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_file())
            .unwrap_or_else(|| PathBuf::from("/bin/sh"));
        let mut command = CommandBuilder::new(program);
        command.arg("-l");
        sanitize_environment(&mut command);
        Ok(command)
    }
}

fn sanitize_environment(command: &mut CommandBuilder) {
    // A new desktop session must not inherit the launching agent's identity or
    // accidentally report to the original app's daemon through inherited hooks.
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name.starts_with("UTERM")
            || name.starts_with("CLAUDE_CODE_")
            || name.starts_with("VSCODE_")
            || name.starts_with("GHOSTTY_")
            || matches!(
                name.as_ref(),
                "CLAUDECODE" | "TMUX" | "TMUX_PANE" | "STY" | "WT_SESSION"
            )
        {
            command.env_remove(&key);
        }
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "uTermDesktop");
}

#[cfg(unix)]
pub struct ProcessGroup;

#[cfg(unix)]
impl ProcessGroup {
    pub fn attach(_child: &dyn Child) -> Result<Self> {
        Ok(Self)
    }

    pub fn terminate(&self, child: &mut dyn Child, master: Option<&dyn MasterPty>) -> Result<()> {
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        let own_group = unsafe { libc::getpgrp() };
        let foreground = master.and_then(|master| master.process_group_leader());
        let leader = child.process_id().and_then(|pid| i32::try_from(pid).ok());
        for group in [foreground, leader].into_iter().flatten() {
            if group > 1 && group != own_group {
                let result = unsafe { libc::kill(-group, libc::SIGKILL) };
                if result < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() != Some(libc::ESRCH) {
                        eprintln!("utermd-local: could not terminate process group: {error}");
                    }
                }
            }
        }
        child.kill().context("terminating shell")
    }
}

#[cfg(windows)]
pub struct ProcessGroup(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl ProcessGroup {
    pub fn attach(child: &dyn Child) -> Result<Self> {
        let process = child
            .as_raw_handle()
            .context("Shell has no process handle")?;
        Self::attach_handle(process)
    }

    fn attach_handle(process: std::os::windows::io::RawHandle) -> Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::*;
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let job = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0 {
            return Err(std::io::Error::last_os_error()).context("assigning shell to a job");
        }
        Ok(Self(job))
    }

    pub fn terminate(&self, _child: &mut dyn Child, _master: Option<&dyn MasterPty>) -> Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
            return Err(std::io::Error::last_os_error()).context("terminating shell job");
        }
        Ok(())
    }
}

pub struct BackgroundChild {
    child: std::process::Child,
    #[cfg(windows)]
    group: ProcessGroup,
}

impl BackgroundChild {
    pub fn spawn(command: &mut std::process::Command) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command.spawn()?;
        #[cfg(windows)]
        let group = {
            use std::os::windows::io::AsRawHandle;
            match ProcessGroup::attach_handle(AsRawHandle::as_raw_handle(&child)) {
                Ok(group) => group,
                Err(error) => {
                    let mut child = child;
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            }
        };
        Ok(Self {
            child,
            #[cfg(windows)]
            group,
        })
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }
}

impl Drop for BackgroundChild {
    fn drop(&mut self) {
        // Stop the entire installer tree before releasing its lock or output file.
        // 释放安装锁或输出文件前终止整个安装进程树。
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(
                    self.group.0.as_raw_handle(),
                    1,
                );
            }
        }
        #[cfg(unix)]
        if let Ok(pid) = i32::try_from(self.child.id()) {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(all(test, windows))]
mod background_tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    #[test]
    fn background_cleanup_terminates_installer_descendants() {
        let powershell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(&powershell);
        command.args(["-NoProfile", "-Command", "$p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile', '-Command', 'Start-Sleep 60' -WindowStyle Hidden -PassThru; Write-Output $p.Id; Start-Sleep 60"]);
        command.stdout(Stdio::piped());
        let mut child = BackgroundChild::spawn(&mut command).unwrap();
        let parent = child.child.id();
        let mut line = String::new();
        BufReader::new(child.child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let descendant: u32 = line.trim().parse().unwrap();
        assert!(process_snapshot().unwrap().contains_key(&descendant));
        drop(child);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let processes = process_snapshot().unwrap();
            if !processes.contains_key(&parent) && !processes.contains_key(&descendant) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "installer descendants survived cleanup"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

fn command_path() -> Vec<PathBuf> {
    let mut paths: Vec<_> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        for relative in [
            ".local/bin",
            ".cargo/bin",
            ".npm-global/bin",
            ".opencode/bin",
        ] {
            paths.push(PathBuf::from(&home).join(relative));
        }
    }
    #[cfg(unix)]
    {
        paths.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
    }
    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(root).join("npm"));
        }
    }
    paths
}

pub fn agent_program(name: &str) -> Result<PathBuf> {
    if !["codex", "claude", "gemini", "opencode", "kimi", "grok"].contains(&name) {
        bail!("Unsupported chat agent");
    }
    resolve_program(name)
}

pub fn resolve_program(name: &str) -> Result<PathBuf> {
    if std::path::Path::new(name).is_absolute() {
        let path = PathBuf::from(name);
        if !path.is_file() {
            bail!("程序文件不存在。");
        }
        return Ok(path);
    }
    if name.contains(['/', '\\']) || name.is_empty() {
        bail!("程序必须是绝对路径或 PATH 中的命令。");
    }
    for directory in command_path() {
        #[cfg(unix)]
        let candidates = vec![directory.join(name)];
        #[cfg(windows)]
        let candidates = vec![
            directory.join(format!("{name}.exe")),
            directory.join(format!("{name}.cmd")),
        ];
        for candidate in candidates {
            if !candidate.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if candidate.metadata()?.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return Ok(candidate);
        }
    }
    bail!("{name} is not installed or is not on PATH")
}

pub fn launch_command(
    shell: &str,
    agent: Option<&str>,
    configuration: &std::path::Path,
) -> Result<CommandBuilder> {
    let Some(agent) = agent else {
        return shell_command(shell);
    };
    let (program, arguments) = crate::agents::resolve(configuration, agent)?;
    #[cfg(unix)]
    let mut command = {
        let mut command = CommandBuilder::new(program);
        command.args(&arguments);
        command
    };
    #[cfg(windows)]
    let mut command = if program
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
    {
        let root = std::env::var_os("SystemRoot").context("SystemRoot is not set")?;
        let mut command = CommandBuilder::new(
            PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        command.args(["-NoLogo", "-NoProfile", "-Command"]);
        command.arg(format!(
            "& '{}' {}",
            program.to_string_lossy().replace('\'', "''"),
            arguments
                .iter()
                .map(|value| format!("'{}'", value.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(" ")
        ));
        command
    } else {
        let mut command = CommandBuilder::new(program);
        command.args(&arguments);
        command
    };
    sanitize_environment(&mut command);
    command.env("PATH", std::env::join_paths(command_path())?);
    Ok(command)
}
