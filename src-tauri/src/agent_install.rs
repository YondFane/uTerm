use std::io::{Read, Seek, SeekFrom};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static INSTALL_LOCK: Mutex<()> = Mutex::new(());

fn npm_extra_arguments(agent: &str) -> &'static [&'static str] {
    if agent == "minimax" {
        &[
            "--ignore-scripts=false",
            "--include=optional",
            "--allow-scripts=@minimax-ai/code,better-sqlite3",
        ]
    } else {
        &[]
    }
}

fn hermes_install_arguments(script: &std::path::Path, windows: bool) -> Vec<std::ffi::OsString> {
    let mut arguments: Vec<std::ffi::OsString> = if windows {
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]
            .into_iter()
            .map(Into::into)
            .collect()
    } else {
        vec![]
    };
    arguments.push(script.as_os_str().to_owned());
    arguments.extend(
        if windows {
            ["-NonInteractive", "-SkipBrowser", "-SkipComputerUse"]
        } else {
            ["--non-interactive", "--skip-browser", "--skip-computer-use"]
        }
        .into_iter()
        .map(std::ffi::OsString::from),
    );
    arguments
}

fn package(agent: &str) -> Result<&'static str, String> {
    match agent {
        "opencode" => Ok("opencode-ai"),
        "claude" => Ok("@anthropic-ai/claude-code"),
        "codex" => Ok("@openai/codex"),
        "gemini" => Ok("@google/gemini-cli"),
        "pi" => Ok("@earendil-works/pi-coding-agent"),
        "qwen" => Ok("@qwen-code/qwen-code"),
        "copilot" => Ok("@github/copilot"),
        "iflow" => Ok("@iflow-ai/iflow-cli"),
        "minimax" => Ok("@minimax-ai/code"),
        _ => Err("此 Agent 不支持自动安装，请按其发布方说明安装后配置程序路径。".into()),
    }
}

fn install(agent: &str) -> Result<bool, String> {
    if agent == "hermes" {
        let _guard = INSTALL_LOCK
            .try_lock()
            .map_err(|_| "已有 Agent 正在安装。")?;
        return install_hermes();
    }
    let package = package(agent)?;
    let _guard = INSTALL_LOCK
        .try_lock()
        .map_err(|_| "已有 Agent 正在安装。")?;
    let npm = utermd_local::resolve_program("npm")
        .map_err(|_| "未找到 npm，请先安装 Node.js，再重启 uTerm 后重试。")?;
    let node = utermd_local::resolve_program("node")
        .map_err(|_| "未找到 npm，请先安装 Node.js，再重启 uTerm 后重试。")?;
    // Run npm through Node without interpreting executable paths as shell code.
    // 通过 Node 运行 npm，不将可执行文件路径作为 Shell 代码解释。
    #[cfg(windows)]
    let cli = npm
        .parent()
        .ok_or("找不到 npm CLI。")?
        .join("node_modules/npm/bin/npm-cli.js");
    #[cfg(not(windows))]
    let cli = npm.canonicalize().map_err(|error| error.to_string())?;
    if !cli.is_file() {
        return Err("找不到 npm CLI。".into());
    }
    let log = tempfile::tempfile().map_err(|error| error.to_string())?;
    let mut command = Command::new(&node);
    command.arg(cli).args([
        "install",
        "--global",
        package,
        "--no-audit",
        "--no-fund",
        "--fetch-retries=2",
        "--fetch-retry-mintimeout=2000",
        "--fetch-retry-maxtimeout=10000",
        "--fetch-timeout=120000",
    ]);
    command.args(npm_extra_arguments(agent));
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        command.current_dir(home);
    }
    let mut paths = vec![node.parent().ok_or("找不到 npm CLI。")?.to_path_buf()];
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    command.env(
        "PATH",
        std::env::join_paths(paths).map_err(|error| error.to_string())?,
    );
    command
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|error| error.to_string())?)
        .stderr(log.try_clone().map_err(|error| error.to_string())?);
    let mut child =
        utermd_local::BackgroundChild::spawn(&mut command).map_err(|error| error.to_string())?;
    wait_for_install(&mut child, log)?;
    Ok(utermd_local::agent_program(agent).is_ok())
}

fn install_hermes() -> Result<bool, String> {
    let url = if cfg!(windows) {
        "https://hermes-agent.nousresearch.com/install.ps1"
    } else {
        "https://hermes-agent.nousresearch.com/install.sh"
    };
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| error.to_string())?
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("AGENT_INSTALL_FAILED\n{error}"))?;
    let mut bytes = Vec::new();
    response
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("安装超时或输出过多，请查看官方安装说明。".into());
    }
    let mut script = tempfile::Builder::new()
        .suffix(if cfg!(windows) { ".ps1" } else { ".sh" })
        .tempfile()
        .map_err(|error| error.to_string())?;
    use std::io::Write;
    script
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    script.flush().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let mut command = {
        let root = std::env::var_os("SystemRoot").ok_or("SystemRoot is not set")?;
        let mut command = Command::new(
            std::path::PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        command.args(hermes_install_arguments(script.path(), true));
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command =
            Command::new(utermd_local::resolve_program("bash").map_err(|error| error.to_string())?);
        command.args(hermes_install_arguments(script.path(), false));
        command
    };
    let log = tempfile::tempfile().map_err(|error| error.to_string())?;
    command
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|error| error.to_string())?)
        .stderr(log.try_clone().map_err(|error| error.to_string())?);
    let mut child =
        utermd_local::BackgroundChild::spawn(&mut command).map_err(|error| error.to_string())?;
    wait_for_install(&mut child, log)?;
    Ok(utermd_local::agent_program("hermes").is_ok())
}

fn wait_for_install(
    child: &mut utermd_local::BackgroundChild,
    mut log: std::fs::File,
) -> Result<(), String> {
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                return Err(error.to_string());
            }
        }
        if start.elapsed() > Duration::from_secs(600)
            || log
                .metadata()
                .map(|value| value.len() > 10 * 1024 * 1024)
                .unwrap_or(true)
        {
            return Err("安装超时或输出过多，请查看官方安装说明。".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    if !status.success() {
        let length = log.metadata().map_err(|error| error.to_string())?.len();
        log.seek(SeekFrom::Start(length.saturating_sub(16 * 1024)))
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        log.take(16 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        let output = String::from_utf8_lossy(&bytes);
        return Err(format!("{}\n{}", install_error(&output), output));
    }
    Ok(())
}

fn install_error(output: &str) -> &'static str {
    if ["EACCES", "EPERM"].iter().any(|code| output.contains(code)) {
        "AGENT_PERMISSION"
    } else if output.contains("ENOSPC") {
        "DOWNLOAD_STORAGE"
    } else if [
        "CERT_HAS_EXPIRED",
        "UNABLE_TO_VERIFY",
        "SELF_SIGNED_CERT",
        "ERR_TLS_CERT",
    ]
    .iter()
    .any(|code| output.contains(code))
    {
        "DOWNLOAD_TLS"
    } else if ["ETIMEDOUT", "ESOCKETTIMEDOUT"]
        .iter()
        .any(|code| output.contains(code))
    {
        "DOWNLOAD_TIMEOUT"
    } else if ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]
        .iter()
        .any(|code| output.contains(code))
    {
        "DOWNLOAD_NETWORK"
    } else if output.contains("E404") {
        "DOWNLOAD_NOT_FOUND"
    } else if output.contains("E401") || output.contains("E403") {
        "DOWNLOAD_ACCESS"
    } else if output.contains("E429") {
        "DOWNLOAD_RATE_LIMIT"
    } else if output.contains("EBADENGINE") {
        "AGENT_NODE_VERSION"
    } else {
        "AGENT_INSTALL_FAILED"
    }
}

#[tauri::command]
pub async fn install_agent(agent: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || install(&agent))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_install_arguments_keep_literal_paths_and_required_dependency_flags() {
        let script = std::path::Path::new("C:/用户 files/$literal'&/install.ps1");
        let windows = hermes_install_arguments(script, true);
        assert_eq!(windows[3], "-File");
        assert_eq!(windows[4], script.as_os_str());
        assert!(windows.iter().any(|argument| argument == "-NonInteractive"));
        assert!(windows.iter().any(|argument| argument == "-SkipBrowser"));
        assert!(!windows
            .iter()
            .any(|argument| argument == "-Command" || argument == "-ExecutionPolicy"));
        let unix = hermes_install_arguments(script, false);
        assert_eq!(unix[0], script.as_os_str());
        assert_eq!(unix[1], "--non-interactive");
        assert!(npm_extra_arguments("minimax").contains(&"--include=optional"));
        assert!(npm_extra_arguments("minimax").contains(&"--ignore-scripts=false"));
        assert!(npm_extra_arguments("pi").is_empty());
        assert!(package("hermes").is_err());
    }

    #[test]
    fn only_verified_packages_can_be_installed() {
        assert_eq!(package("opencode").unwrap(), "opencode-ai");
        assert_eq!(package("codex").unwrap(), "@openai/codex");
        assert_eq!(package("claude").unwrap(), "@anthropic-ai/claude-code");
        assert_eq!(package("gemini").unwrap(), "@google/gemini-cli");
        assert_eq!(package("pi").unwrap(), "@earendil-works/pi-coding-agent");
        assert_eq!(package("qwen").unwrap(), "@qwen-code/qwen-code");
        assert_eq!(package("copilot").unwrap(), "@github/copilot");
        assert_eq!(package("iflow").unwrap(), "@iflow-ai/iflow-cli");
        assert_eq!(package("minimax").unwrap(), "@minimax-ai/code");
        for name in ["grok", "kimi", "custom", "opencode;echo", "--prefix=/tmp"] {
            assert!(package(name).is_err());
            assert!(install(name).is_err());
        }
    }

    #[test]
    fn installation_failures_distinguish_network_permissions_and_runtime_requirements() {
        for (output, code) in [
            ("npm error code ECONNRESET", "DOWNLOAD_NETWORK"),
            ("npm error code EACCES", "AGENT_PERMISSION"),
            ("npm error code ENOSPC", "DOWNLOAD_STORAGE"),
            ("npm error CERT_HAS_EXPIRED", "DOWNLOAD_TLS"),
            ("npm error code EBADENGINE", "AGENT_NODE_VERSION"),
            ("postinstall failed", "AGENT_INSTALL_FAILED"),
        ] {
            assert_eq!(install_error(output), code);
        }
    }
}
