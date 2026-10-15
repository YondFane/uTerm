use std::io::{Read, Seek, SeekFrom};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static INSTALL_LOCK: Mutex<()> = Mutex::new(());

fn package(agent: &str) -> Result<&'static str, String> {
    match agent {
        "opencode" => Ok("opencode-ai"),
        "claude" => Ok("@anthropic-ai/claude-code"),
        "codex" => Ok("@openai/codex"),
        "gemini" => Ok("@google/gemini-cli"),
        _ => Err("此 Agent 不支持自动安装，请按其发布方说明安装后配置程序路径。".into()),
    }
}

fn install(agent: &str) -> Result<bool, String> {
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
    let mut log = tempfile::tempfile().map_err(|error| error.to_string())?;
    let mut command = Command::new(&node);
    command.arg(cli).args([
        "install",
        "--global",
        package,
        "--no-audit",
        "--no-fund",
        "--fetch-retries=1",
        "--fetch-timeout=60000",
    ]);
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
        return Err(format!(
            "{}\n{}",
            "安装失败，请检查网络、权限和 Node.js 版本。",
            String::from_utf8_lossy(&bytes)
        ));
    }
    Ok(utermd_local::agent_program(agent).is_ok())
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
    fn only_verified_packages_can_be_installed() {
        assert_eq!(package("opencode").unwrap(), "opencode-ai");
        assert_eq!(package("codex").unwrap(), "@openai/codex");
        assert_eq!(package("claude").unwrap(), "@anthropic-ai/claude-code");
        assert_eq!(package("gemini").unwrap(), "@google/gemini-cli");
        for name in ["grok", "kimi", "custom", "opencode;echo", "--prefix=/tmp"] {
            assert!(package(name).is_err());
            assert!(install(name).is_err());
        }
    }
}
