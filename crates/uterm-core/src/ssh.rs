pub mod paths;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tokio::io::AsyncReadExt;
use utermd_local::{
    ssh::{validate_host, SshTarget},
    BackgroundChild,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[schemars(rename = "SshInfo")]
pub struct Info {
    pub available: bool,
    pub aliases: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[schemars(rename = "SshResolution")]
pub struct Resolution {
    pub hostname: String,
    pub username: String,
    pub port: String,
    pub proxy: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveRequest {
    pub connection: SshTarget,
}
impl From<EffectiveSsh> for Resolution {
    fn from(value: EffectiveSsh) -> Self {
        Self {
            hostname: value.hostname,
            username: value.user,
            port: value.port,
            proxy: value.proxy,
        }
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
#[cfg(unix)]
pub fn pipe_file<T: Into<std::os::fd::OwnedFd>>(pipe: T) -> tokio::fs::File {
    tokio::fs::File::from_std(std::fs::File::from(pipe.into()))
}
#[cfg(windows)]
pub fn pipe_file<T: Into<std::os::windows::io::OwnedHandle>>(pipe: T) -> tokio::fs::File {
    tokio::fs::File::from_std(std::fs::File::from(pipe.into()))
}
pub fn base_command() -> Result<Command> {
    let mut command = Command::new(utermd_local::ssh::program()?);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
        .env_remove("SSH_ASKPASS")
        .env("SSH_ASKPASS_REQUIRE", "never");
    Ok(command)
}
#[derive(Clone)]
pub struct EffectiveSsh {
    pub identity: String,
    pub hostname: String,
    pub user: String,
    pub port: String,
    pub proxy: bool,
    pub forwarding: bool,
    pub password_host: String,
}
pub async fn effective_identity(host: &str) -> Result<EffectiveSsh> {
    effective_config(host, vec![]).await
}
pub async fn effective_target(target: &SshTarget) -> Result<EffectiveSsh> {
    target.validate()?;
    effective_config(&target.host, target.options()).await
}
async fn effective_config(host: &str, options: Vec<String>) -> Result<EffectiveSsh> {
    validate_host(host)?;
    let mut command = base_command()?;
    command.args(&options);
    command.args(["-G", "--", host]);
    let mut child = BackgroundChild::spawn(&mut command)?;
    drop(child.take_stdin());
    let mut stdout =
        pipe_file(child.take_stdout().context("SSH_PIPE_FAILED")?).take(1024 * 1024 + 1);
    let mut stderr = pipe_file(child.take_stderr().context("SSH_PIPE_FAILED")?).take(16 * 1024);
    let mut output = Vec::new();
    let mut errors = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), async {
        let (out, err) = tokio::join!(
            stdout.read_to_end(&mut output),
            stderr.read_to_end(&mut errors)
        );
        out?;
        err?;
        loop {
            if let Some(status) = child.try_wait()? {
                if !status.success() {
                    bail!("SSH_CONFIG_FAILED: {}", String::from_utf8_lossy(&errors));
                }
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("SSH_TIMEOUT")??;
    if output.len() > 1024 * 1024 {
        bail!("SSH_CONFIG_FAILED");
    }
    let text = std::str::from_utf8(&output)?;
    let fields: Vec<_> = text
        .lines()
        .filter(|line| {
            [
                "hostname ",
                "user ",
                "port ",
                "hostkeyalias ",
                "proxyjump ",
                "proxycommand ",
                "userknownhostsfile ",
            ]
            .iter()
            .any(|key| line.starts_with(key))
        })
        .collect();
    if !fields.iter().any(|line| line.starts_with("hostname ")) {
        bail!("SSH_CONFIG_FAILED");
    }
    let option = |name: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(name))
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("SSH_CONFIG_FAILED"))
    };
    let identity = if options.is_empty() {
        fields.join("\n")
    } else {
        format!(
            "{}\n{}",
            fields.join("\n"),
            serde_json::to_string(&options)?
        )
    };
    Ok(EffectiveSsh {
        identity: digest(identity.as_bytes()),
        hostname: option("hostname ")?,
        password_host: option("hostkeyalias ")
            .ok()
            .filter(|v| v != "none")
            .unwrap_or(option("hostname ")?),
        user: option("user ")?,
        port: option("port ")?,
        proxy: text.lines().any(|line| {
            ["proxyjump ", "proxycommand "].iter().any(|key| {
                line.strip_prefix(key)
                    .is_some_and(|v| !v.is_empty() && v != "none")
            })
        }),
        forwarding: text.lines().any(|line| {
            ["localforward ", "remoteforward ", "dynamicforward "]
                .iter()
                .any(|prefix| line.starts_with(prefix))
        }),
    })
}
fn aliases(path: &Path, seen: &mut HashSet<PathBuf>, values: &mut HashSet<String>, depth: usize) {
    if depth > 16 || seen.len() >= 128 {
        return;
    }
    let Ok(path) = path.canonicalize() else {
        return;
    };
    if !seen.insert(path.clone()) {
        return;
    }
    let Ok(file) = std::fs::File::open(&path) else {
        return;
    };
    let mut text = String::new();
    if file
        .take(1024 * 1024 + 1)
        .read_to_string(&mut text)
        .is_err()
    {
        return;
    }
    if text.len() > 1024 * 1024 {
        return;
    }
    for line in text.lines() {
        let mut words = line.split('#').next().unwrap_or("").split_whitespace();
        let Some(key) = words.next() else {
            continue;
        };
        if key.eq_ignore_ascii_case("host") {
            for host in words {
                if validate_host(host).is_ok() {
                    values.insert(host.to_owned());
                }
            }
        } else if key.eq_ignore_ascii_case("include") {
            for include in words {
                let include = include
                    .trim_matches(char::from(34))
                    .trim_matches(char::from(39));
                let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .map(PathBuf::from)
                    .unwrap_or_default();
                let include = if let Some(tail) = include.strip_prefix("~/") {
                    home.join(tail)
                } else if Path::new(include).is_absolute() {
                    include.into()
                } else {
                    home.join(".ssh").join(include)
                };
                if let Some(pattern) = include.to_str() {
                    if let Ok(paths) = glob::glob(pattern) {
                        for file in paths.flatten() {
                            aliases(&file, seen, values, depth + 1);
                        }
                    }
                }
            }
        }
    }
}
pub fn info() -> Info {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut values = HashSet::new();
    aliases(
        &home.join(".ssh/config"),
        &mut HashSet::new(),
        &mut values,
        0,
    );
    let mut aliases: Vec<_> = values.into_iter().collect();
    aliases.sort();
    Info {
        available: utermd_local::ssh::program().is_ok(),
        aliases,
    }
}
pub fn resolve(connection: SshTarget) -> Result<Resolution> {
    connection.validate()?;
    // A dedicated worker lets synchronous FFI callers coexist with the client's Tokio runtime.
    // 独立工作线程让同步 FFI 调用与客户端的 Tokio 运行时兼容。
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime
            .block_on(effective_target(&connection))
            .map(Resolution::from)
    })
    .join()
    .map_err(|_| anyhow!("SSH_CONFIG_FAILED"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_alias_source_cannot_publish_partial_hosts() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config");
        let mut text = "Host must-not-be-published\n#".to_owned();
        text.push_str(&"x".repeat(1024 * 1024));
        std::fs::write(&config, text).unwrap();
        let mut values = HashSet::new();
        aliases(&config, &mut HashSet::new(), &mut values, 0);
        assert!(values.is_empty());
    }
    #[test]
    fn alias_discovery_bounds_deep_and_wide_include_trees() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..19 {
            let next = directory.path().join(format!("depth-{}", index + 1));
            std::fs::write(
                directory.path().join(format!("depth-{index}")),
                format!("Host depth-{index}\nInclude {}\n", next.display()),
            )
            .unwrap();
        }
        let mut values = HashSet::new();
        aliases(
            &directory.path().join("depth-0"),
            &mut HashSet::new(),
            &mut values,
            0,
        );
        assert_eq!(values.len(), 17);
        assert!(values.contains("depth-16") && !values.contains("depth-17"));
        for index in 0..140 {
            std::fs::write(
                directory.path().join(format!("wide-{index:03}")),
                format!("Host wide-{index}\n"),
            )
            .unwrap();
        }
        let config = directory.path().join("config");
        std::fs::write(
            &config,
            format!("Include {}\n", directory.path().join("wide-*").display()),
        )
        .unwrap();
        let mut values = HashSet::new();
        let mut seen = HashSet::new();
        aliases(&config, &mut seen, &mut values, 0);
        assert_eq!(seen.len(), 128);
        assert_eq!(values.len(), 127);
    }
    #[tokio::test]
    async fn actual_openssh_config_resolution_preserves_identity_proxy_and_forwarding() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("literal config.txt");
        let text = "Host qa-target\n HostName 127.0.0.1\n User qa-user\n Port 2222\n HostKeyAlias qa-known-host\n ProxyJump qa-jump.invalid\n LocalForward 127.0.0.1:19090 127.0.0.1:18080\n";
        std::fs::write(&config, text).unwrap();
        let options = vec!["-F".into(), config.to_str().unwrap().into()];
        let first = effective_config("qa-target", options.clone())
            .await
            .unwrap();
        assert_eq!(first.hostname, "127.0.0.1");
        assert_eq!(first.user, "qa-user");
        assert_eq!(first.port, "2222");
        assert_eq!(first.password_host, "qa-known-host");
        assert!(first.proxy && first.forwarding);
        assert_eq!(first.identity.len(), 64);
        let again = effective_config("qa-target", options.clone())
            .await
            .unwrap();
        assert_eq!(first.identity, again.identity);
        std::fs::write(&config, text.replace("qa-user", "different-user")).unwrap();
        let changed = effective_config("qa-target", options.clone())
            .await
            .unwrap();
        assert_ne!(first.identity, changed.identity);
        std::fs::write(&config, "Port invalid\n").unwrap();
        let failure = effective_config("qa-target", options).await.err().unwrap();
        assert!(failure.to_string().starts_with("SSH_CONFIG_FAILED"));
    }
    #[tokio::test]
    async fn synchronous_ffi_resolution_coexists_with_the_callers_runtime() {
        let connection = SshTarget {
            connection_id: "qa".into(),
            workspace_id: "local".into(),
            name: "QA".into(),
            host: "127.0.0.1".into(),
            os: "posix".into(),
            mode: Some("direct".into()),
            port: Some(2222),
            username: Some("qa-user".into()),
            ..Default::default()
        };
        let resolved = resolve(connection).unwrap();
        assert_eq!(resolved.hostname, "127.0.0.1");
        assert_eq!(resolved.username, "qa-user");
        assert_eq!(resolved.port, "2222");
    }
    #[test]
    fn alias_discovery_does_not_execute_match_rules_and_stops_include_cycles() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config");
        let included = directory.path().join("included");
        std::fs::write(
            &config,
            format!(
                "Host prod lab *.wild !excluded\n Match exec touch-never-run\n Include {}\n",
                included.display()
            ),
        )
        .unwrap();
        std::fs::write(
            &included,
            format!("Host jump\n Include {}\n", config.display()),
        )
        .unwrap();
        let mut values = HashSet::new();
        aliases(&config, &mut HashSet::new(), &mut values, 0);
        assert_eq!(
            values,
            ["prod", "lab", "jump"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        );
    }
}
