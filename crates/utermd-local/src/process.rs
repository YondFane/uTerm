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
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::*;
        let process = child
            .as_raw_handle()
            .context("Shell has no process handle")?;
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

fn command_path() -> Vec<PathBuf> {
    let mut paths: Vec<_> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        for relative in [".local/bin", ".cargo/bin", ".npm-global/bin"] {
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
    if !["codex", "claude", "gemini"].contains(&name) {
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
