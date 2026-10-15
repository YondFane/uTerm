use anyhow::{bail, Context, Result};
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SshTarget {
    pub connection_id: String,
    pub workspace_id: String,
    pub name: String,
    pub host: String,
    pub os: String,
    pub root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authentication: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remember_password: Option<bool>,
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
        if self
            .mode
            .as_deref()
            .is_some_and(|v| !["alias", "direct"].contains(&v))
            || self.port == Some(0)
            || self
                .username
                .as_ref()
                .is_some_and(|v| v.len() > 512 || v.trim() != v || v.chars().any(char::is_control))
            || self
                .identity_file
                .as_ref()
                .is_some_and(|v| v.len() > 4096 || v.chars().any(char::is_control))
            || self
                .authentication
                .as_deref()
                .is_some_and(|v| !["config", "key", "password"].contains(&v))
            || (self.mode.as_deref() == Some("direct")
                && (self.host.contains('@') || self.port.is_none()))
            || self
                .credential_id
                .as_ref()
                .is_some_and(|v| uuid::Uuid::parse_str(v).is_err())
        {
            bail!("SSH_INVALID_CONNECTION");
        }
        Ok(())
    }

    pub fn options(&self) -> Vec<String> {
        let mut args = Vec::new();
        if self.mode.as_deref() == Some("direct") {
            args.extend([
                "-o".into(),
                format!(
                    "HostName={}",
                    self.host.trim_start_matches('[').trim_end_matches(']')
                ),
            ]);
        }
        if let Some(port) = self.port {
            args.extend(["-p".into(), port.to_string()]);
        }
        if let Some(user) = self.username.as_ref().filter(|v| !v.is_empty()) {
            args.extend(["-l".into(), user.clone()]);
        }
        if let Some(path) = self.identity_file.as_ref().filter(|v| !v.is_empty()) {
            args.extend([
                "-i".into(),
                path.clone(),
                "-o".into(),
                "IdentitiesOnly=yes".into(),
            ]);
        }
        match self.authentication.as_deref() {
            Some("key") => args.extend(["-o".into(), "PreferredAuthentications=publickey".into()]),
            Some("password") => args.extend([
                "-o".into(),
                "PreferredAuthentications=password".into(),
                "-o".into(),
                "PubkeyAuthentication=no".into(),
                "-o".into(),
                "KbdInteractiveAuthentication=no".into(),
                "-o".into(),
                "PasswordAuthentication=yes".into(),
                "-o".into(),
                "NumberOfPasswordPrompts=1".into(),
                "-o".into(),
                "BatchMode=no".into(),
            ]),
            _ => {}
        }
        args
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResolvedTarget {
    pub hostname: String,
    pub user: String,
    pub port: u16,
}
impl ResolvedTarget {
    pub fn options(&self) -> Result<Vec<String>> {
        validate_host(&self.hostname)?;
        if self.hostname.contains('@')
            || self.port == 0
            || self.user.len() > 512
            || self.user.chars().any(char::is_control)
        {
            bail!("SSH_INVALID_CONNECTION");
        }
        Ok(vec![
            "-o".into(),
            format!("HostName={}", self.hostname),
            "-l".into(),
            self.user.clone(),
            "-p".into(),
            self.port.to_string(),
        ])
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
    configured_command(target, None, None)
}
pub fn configured_command(
    target: &SshTarget,
    resolved: Option<&ResolvedTarget>,
    askpass: Option<&crate::ssh_askpass::Endpoint>,
) -> Result<CommandBuilder> {
    target.validate()?;
    let mut command = CommandBuilder::new(program()?);
    crate::process::sanitize_environment(&mut command);
    command.args(target.options());
    if let Some(resolved) = resolved {
        command.args(resolved.options()?);
    }
    if let Some(endpoint) = askpass {
        command.args(["-o", "ProxyCommand=none", "-o", "ProxyJump=none"]);
        for (key, value) in endpoint.environment()? {
            command.env(key, value);
        }
    }
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

    #[test]
    fn explicit_options_preserve_argument_boundaries_and_legacy_serialization() {
        let legacy = serde_json::json!({"connection_id":"id","workspace_id":"ws","name":"Name","host":"lab","os":"posix","root":""});
        let mut target: SshTarget = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(&target).unwrap(), legacy);
        assert!(target.options().is_empty());
        target.mode = Some("direct".into());
        assert!(target.validate().is_err());
        target.port = Some(2222);
        target.username = Some("qa user".into());
        target.identity_file = Some("/keys/a $(touch ignored) key".into());
        target.authentication = Some("key".into());
        target.validate().unwrap();
        let options = target.options();
        assert!(options.windows(2).any(|v| v == ["-p", "2222"]));
        assert!(options.windows(2).any(|v| v == ["-l", "qa user"]));
        assert!(options
            .windows(2)
            .any(|v| v == ["-i", "/keys/a $(touch ignored) key"]));
        target.authentication = Some("password".into());
        let options = target.options();
        assert!(options.contains(&"PreferredAuthentications=password".into()));
        assert!(options.contains(&"KbdInteractiveAuthentication=no".into()));
        assert!(options.contains(&"NumberOfPasswordPrompts=1".into()));
        target.credential_id = Some("plaintext-password".into());
        assert!(target.validate().is_err());
        let mut secret = legacy;
        secret["password"] = "secret".into();
        assert!(serde_json::from_value::<SshTarget>(secret).is_err());
    }
}
