use anyhow::{bail, Context, Result};
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshTarget {
    pub connection_id: String,
    pub workspace_id: String,
    pub name: String,
    pub host: String,
    pub os: String,
    pub root: String,
}

pub fn validate_host(host: &str) -> Result<()> {
    if host.is_empty()
        || host.len() > 255
        || host.starts_with('-')
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-@:[]".contains(&byte))
    {
        bail!("SSH_INVALID_HOST");
    }
    Ok(())
}

impl SshTarget {
    pub fn validate(&self) -> Result<()> {
        validate_host(&self.host)?;
        if self.connection_id.is_empty()
            || self.workspace_id.is_empty()
            || self.name.trim().is_empty()
            || !["posix", "windows"].contains(&self.os.as_str())
            || self.root.len() > 4096
            || self.root.contains(['\0', '\r', '\n'])
        {
            bail!("SSH_INVALID_CONNECTION");
        }
        Ok(())
    }
}

pub fn program() -> Result<PathBuf> {
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        let path = PathBuf::from(root).join("System32/OpenSSH/ssh.exe");
        if path.is_file() {
            return Ok(path);
        }
    }
    let path = crate::resolve_program("ssh").context("SSH_NOT_INSTALLED")?;
    if path
        .extension()
        .is_some_and(|value| value == "cmd" || value == "bat")
    {
        bail!("SSH_NOT_INSTALLED");
    }
    Ok(path.canonicalize()?)
}

pub fn terminal_command(target: &SshTarget) -> Result<CommandBuilder> {
    target.validate()?;
    let mut command = CommandBuilder::new(program()?);
    crate::process::sanitize_environment(&mut command);
    command.args([
        "-tt",
        "-S",
        "none",
        "-o",
        "ControlMaster=no",
        "-o",
        "StrictHostKeyChecking=ask",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "--",
        &target.host,
    ]);
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_names_cannot_be_options_or_shell_code() {
        for host in ["prod", "user@server", "[::1]", "lab.example.com"] {
            validate_host(host).unwrap();
        }
        for host in [
            "",
            "-oProxyCommand=bad",
            "host;echo",
            "$(id)",
            "host name",
            "host\n",
        ] {
            assert!(validate_host(host).is_err(), "{host:?}");
        }
    }
}
