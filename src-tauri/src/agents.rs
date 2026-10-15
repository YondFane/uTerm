use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;
use utermd_local::agents::AgentDefinition;
static CONFIG_LOCK: Mutex<()> = Mutex::new(());
static USAGE_LOCK: Mutex<()> = Mutex::new(());
fn home() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or("找不到用户目录。".into())
}
fn agent_home(agent: &str) -> Result<PathBuf, String> {
    if matches!(agent, "kimi" | "grok") {
        let (variable, fallback) = if agent == "kimi" {
            ("KIMI_CODE_HOME", ".kimi-code")
        } else {
            ("GROK_HOME", ".grok")
        };
        return Ok(std::env::var_os(variable)
            .map(PathBuf::from)
            .unwrap_or(home()?.join(fallback)));
    }
    let variable = if agent == "codex" {
        "CODEX_HOME"
    } else {
        "CLAUDE_CONFIG_DIR"
    };
    if agent != "gemini" {
        if let Some(path) = std::env::var_os(variable) {
            return Ok(PathBuf::from(path));
        }
    }
    Ok(home()?.join(format!(".{agent}")))
}
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}
fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().ok_or("配置路径无效。")?)
        .map_err(|error| error.to_string())?;
    let temporary = path.with_extension("uterm-tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("无法创建配置临时文件：{error}"))?;
    use std::io::Write;
    let result = (|| {
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        // Keep a recoverable copy, including on Windows where rename cannot replace an open file.
        let backup = path.with_extension(format!(
            "backup-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        if path.exists() {
            std::fs::rename(path, &backup).map_err(|error| error.to_string())?;
        }
        if let Err(error) = std::fs::rename(&temporary, path) {
            if backup.exists() {
                std::fs::rename(&backup, path)
                    .map_err(|restore| format!("{error}; 恢复备份失败：{restore}"))?;
            }
            return Err(error.to_string());
        }
        Ok(())
    })();
    if temporary.exists() {
        if let Err(error) = std::fs::remove_file(temporary) {
            eprintln!("Agent temporary file cleanup: {error}");
        }
    }
    result
}
#[tauri::command]
pub fn agent_definitions(app: tauri::AppHandle) -> Result<Vec<AgentDefinition>, String> {
    utermd_local::agents::read(&directory(&app)?).map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn save_agents(
    app: tauri::AppHandle,
    definitions: Vec<AgentDefinition>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CONFIG_LOCK.lock().map_err(|error| error.to_string())?;
        utermd_local::agents::validate(&definitions).map_err(|error| error.to_string())?;
        replace(
            &directory(&app)?.join("agents.json"),
            &serde_json::to_vec_pretty(&definitions).map_err(|error| error.to_string())?,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}
fn merge_hooks(
    mut value: Value,
    agent: &str,
    command: &str,
    enabled: bool,
) -> Result<Value, String> {
    let object = value
        .as_object_mut()
        .ok_or("Agent 配置必须是 JSON 对象，原文件已保留。")?;
    let hooks = object
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Hooks 配置不是对象，原文件已保留。")?;
    for groups in hooks.values_mut() {
        let groups = groups
            .as_array_mut()
            .ok_or("Hooks 列表无效，原文件已保留。")?;
        for group in groups.iter_mut() {
            if let Some(entries) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                entries.retain(|entry| {
                    !entry
                        .get("command")
                        .and_then(Value::as_str)
                        .is_some_and(|text| text.starts_with(command))
                });
            }
        }
        groups.retain(|group| {
            !group
                .get("hooks")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
        });
    }
    if enabled {
        let events = if agent == "gemini" {
            vec![
                ("SessionStart", "idle"),
                ("BeforeAgent", "working"),
                ("BeforeTool", "working"),
                ("AfterTool", "working"),
                ("Notification", "waiting"),
                ("AfterAgent", "done"),
            ]
        } else {
            vec![
                ("SessionStart", "idle"),
                ("UserPromptSubmit", "working"),
                ("PreToolUse", "working"),
                ("PostToolUse", "working"),
                ("PermissionRequest", "waiting"),
                ("Stop", "done"),
            ]
        };
        for (event, state) in events {
            let groups = hooks
                .entry(event)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or("Hooks 列表无效。")?;
            groups.push(json!({"matcher":"*","hooks":[{"type":"command","command":format!("{command} {state}"),"timeout":10}]}));
        }
    }
    Ok(value)
}
#[tauri::command]
pub async fn agent_hooks(
    app: tauri::AppHandle,
    agent: String,
    enabled: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !["claude", "codex", "gemini"].contains(&agent.as_str()) {
            return Err("此 Agent 需自行配置状态回报命令。".into());
        }
        let _guard = CONFIG_LOCK.lock().map_err(|error| error.to_string())?;
        let support = directory(&app)?.join("integration");
        std::fs::create_dir_all(&support).map_err(|error| error.to_string())?;
        let reporter = support.join(if cfg!(windows) {
            "uterm-report.exe"
        } else {
            "uterm-report"
        });
        if enabled {
            std::fs::copy(
                std::env::current_exe().map_err(|error| error.to_string())?,
                &reporter,
            )
            .map_err(|error| error.to_string())?;
        }
        #[cfg(unix)]
        let quoted = format!("'{}'", reporter.to_string_lossy().replace('\'', "'\\''"));
        #[cfg(windows)]
        let quoted = format!("\"{}\"", reporter.display());
        let command = format!("{quoted} --agent-report");
        let path = agent_home(&agent)?.join(if agent == "codex" {
            "hooks.json"
        } else {
            "settings.json"
        });
        let previous = match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        let value = match &previous {
            Some(bytes) => {
                serde_json::from_slice(bytes).map_err(|_| "配置 JSON 无效，原文件已保留。")?
            }
            None => json!({}),
        };
        let next = merge_hooks(value, &agent, &command, enabled)?;
        // Don't overwrite a concurrent edit made by the CLI while the merge was prepared.
        if std::fs::read(&path).ok() != previous {
            return Err("配置已被其他程序修改，请重试。".into());
        }
        replace(
            &path,
            &serde_json::to_vec_pretty(&next).map_err(|error| error.to_string())?,
        )?;
        Ok(format!(
            "{}。新会话生效；原配置已备份。",
            if enabled {
                "Hooks 已安装"
            } else {
                "Hooks 已移除"
            }
        ))
    })
    .await
    .map_err(|error| error.to_string())?
}
#[derive(Default, Serialize)]
pub struct Usage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    records: usize,
    partial: bool,
    windows: Vec<Value>,
    notice: Option<String>,
}
fn tally(value: &Value, codex: bool, usage: &mut Usage) {
    let count = |key: &str| value[key].as_u64().unwrap_or(0);
    let cache = if codex {
        count("cached_input_tokens")
    } else {
        count("cache_read_input_tokens")
    };
    usage.input += if codex {
        count("input_tokens").saturating_sub(cache)
    } else {
        count("input_tokens")
    };
    usage.output += count("output_tokens");
    usage.cache_read += cache;
    usage.cache_write += count("cache_creation_input_tokens");
    usage.records += 1;
}
fn scan_usage(agent: &str, root: &Path) -> Result<Usage, String> {
    let mut usage = Usage::default();
    let cutoff = chrono::Utc::now() - chrono::Duration::days(7);
    let started = Instant::now();
    let mut visited = 0usize;
    let mut directories = vec![(root.to_owned(), 0)];
    let mut files = vec![];
    while let Some((directory, depth)) = directories.pop() {
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        for entry in entries {
            visited += 1;
            if visited > 20_000 || started.elapsed() > Duration::from_secs(5) {
                usage.partial = true;
                break;
            }
            let entry = entry.map_err(|error| error.to_string())?;
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_symlink()
            {
                continue;
            }
            if metadata.is_dir() && depth < 6 {
                directories.push((entry.path(), depth + 1));
            } else if entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "jsonl")
                && metadata
                    .modified()
                    .is_ok_and(|time| chrono::DateTime::<chrono::Utc>::from(time) >= cutoff)
            {
                files.push((entry.path(), metadata));
            }
            if files.len() + directories.len() > 5000 {
                usage.partial = true;
                break;
            }
        }
        if usage.partial {
            break;
        }
    }
    files.sort_by_key(|(_, metadata)| std::cmp::Reverse(metadata.modified().ok()));
    let mut remaining = 64 * 1024 * 1024u64;
    let mut claude = HashMap::new();
    let mut grok_prompts = HashSet::new();
    for (path, metadata) in files {
        if remaining == 0 || started.elapsed() > Duration::from_secs(5) {
            usage.partial = true;
            break;
        }
        let length = metadata.len().min(8 * 1024 * 1024).min(remaining);
        remaining -= length;
        let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
        let offset = metadata.len().saturating_sub(length);
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let mut reader = BufReader::new(file.take(length));
        if offset > 0 {
            let mut first = String::new();
            reader
                .read_line(&mut first)
                .map_err(|error| error.to_string())?;
            usage.partial = true;
        }
        let mut seen = HashSet::new();
        for line in reader.lines() {
            if started.elapsed() > Duration::from_secs(5) {
                usage.partial = true;
                break;
            }
            let line = line.map_err(|error| error.to_string())?;
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if matches!(agent, "kimi" | "grok") {
                let timestamp = if agent == "kimi" {
                    value["time"].as_f64().map(|time| time / 1000.0)
                } else {
                    value["timestamp"].as_f64()
                };
                if !timestamp.is_some_and(|time| time >= cutoff.timestamp() as f64) {
                    continue;
                }
                let tokens = if agent == "kimi" && value["type"] == "usage.record" {
                    let data = &value["usage"];
                    json!({"input_tokens":data["inputOther"],"output_tokens":data["output"],"cache_read_input_tokens":data["inputCacheRead"],"cache_creation_input_tokens":data["inputCacheCreation"]})
                } else if agent == "grok"
                    && value["params"]["update"]["sessionUpdate"] == "turn_completed"
                {
                    let update = &value["params"]["update"];
                    if update["prompt_id"]
                        .as_str()
                        .is_some_and(|id| !grok_prompts.insert(id.to_owned()))
                    {
                        continue;
                    }
                    let data = &update["usage"];
                    if !data.is_object() {
                        continue;
                    }
                    let cache = data["cachedReadTokens"].as_u64().unwrap_or(0);
                    let write = data["cacheCreationTokens"].as_u64().unwrap_or(0);
                    json!({"input_tokens":data["inputTokens"].as_u64().unwrap_or(0).saturating_sub(cache).saturating_sub(write),"output_tokens":data["outputTokens"],"cache_read_input_tokens":cache,"cache_creation_input_tokens":write})
                } else {
                    continue;
                };
                tally(&tokens, false, &mut usage);
                continue;
            }
            let Some(timestamp) = value["timestamp"]
                .as_str()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            else {
                continue;
            };
            if timestamp < cutoff {
                continue;
            }
            if agent == "codex" && value["payload"]["type"] == "token_count" {
                let info = &value["payload"]["info"];
                let total = info["total_token_usage"]["total_tokens"].as_u64();
                if total.is_some_and(|total| !seen.insert(total)) {
                    continue;
                }
                if info["last_token_usage"].is_object() {
                    tally(&info["last_token_usage"], true, &mut usage);
                }
            } else if agent == "claude" {
                if let (Some(id), Some(tokens)) = (
                    value["message"]["id"]
                        .as_str()
                        .or(value["requestId"].as_str()),
                    value["message"]["usage"].as_object(),
                ) {
                    claude.insert(id.to_owned(), Value::Object(tokens.clone()));
                }
            }
        }
    }
    for tokens in claude.values() {
        tally(tokens, false, &mut usage);
    }
    Ok(usage)
}
fn keychain_credentials() -> Result<Vec<u8>, String> {
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("/usr/bin/security");
        command
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        crate::git::run_command(command).map_err(|_| {
            "未能读取 Claude Code 钥匙串凭据。权限可能被拒绝或条目不存在；不会自动重试。".into()
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("当前系统使用 CLI 凭据文件。".into())
    }
}
fn limits(agent: &str, home: &Path, allow_keychain: bool) -> Result<Vec<Value>, String> {
    if matches!(agent, "kimi" | "grok") {
        let path = home.join(if agent == "kimi" {
            "credentials/kimi-code.json"
        } else {
            "auth.json"
        });
        let credentials: Value =
            serde_json::from_slice(&std::fs::read(path).map_err(|_| "未找到 CLI 登录凭据。")?)
                .map_err(|_| "无法读取 CLI 登录凭据。")?;
        let token = if agent == "kimi" {
            credentials["access_token"].as_str()
        } else {
            let scopes = credentials.as_object().ok_or("Grok 登录凭据格式无效。")?;
            scopes
                .values()
                .find(|value| value["auth_mode"] == "oidc" && value["key"].is_string())
                .and_then(|value| value["key"].as_str())
        }
        .filter(|token| !token.is_empty())
        .ok_or("CLI 没有可用的 OAuth 登录凭据。")?;
        let url = if agent == "kimi" {
            "https://api.kimi.com/coding/v1/usages"
        } else {
            "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
        };
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
            .get(url)
            .bearer_auth(token)
            .send()
            .map_err(|_| "无法连接用量服务。")?;
        if !response.status().is_success() {
            return Err(format!(
                "用量服务返回 {}，请先在对应 CLI 中刷新登录状态后重试。",
                response.status().as_u16()
            ));
        }
        let value = response.json().map_err(|_| "无法解析用量响应。")?;
        return parse_limits(agent, &value);
    }
    let path = home.join(if agent == "codex" {
        "auth.json"
    } else {
        ".credentials.json"
    });
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && agent == "claude"
                && allow_keychain =>
        {
            keychain_credentials()?
        }
        Err(_) => return Err("未找到 CLI 登录凭据，仍可查看本地 Token 用量。".into()),
    };
    let credentials: Value =
        serde_json::from_slice(&bytes).map_err(|_| "无法读取 CLI 登录凭据。")?;
    let token = if agent == "codex" {
        credentials["tokens"]["access_token"].as_str()
    } else {
        credentials["claudeAiOauth"]["accessToken"]
            .as_str()
            .or(credentials["accessToken"].as_str())
    }
    .ok_or("CLI 没有可用的 OAuth 登录凭据。")?;
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| error.to_string())?;
    let url = if agent == "codex" {
        "https://chatgpt.com/backend-api/wham/usage"
    } else {
        "https://api.anthropic.com/api/oauth/usage"
    };
    let mut request = client.get(url).bearer_auth(token);
    if agent == "claude" {
        request = request.header("anthropic-beta", "oauth-2025-04-20");
    }
    let response = request
        .send()
        .map_err(|_| "无法连接用量服务，请稍后重试。")?;
    if !response.status().is_success() {
        return Err(format!(
            "用量服务返回 {}，请检查 CLI 登录状态。",
            response.status().as_u16()
        ));
    }
    let value: Value = response.json().map_err(|_| "无法解析用量服务响应。")?;
    parse_limits(agent, &value)
}
fn parse_limits(agent: &str, value: &Value) -> Result<Vec<Value>, String> {
    let mut windows = vec![];
    if agent == "grok" {
        let config = &value["config"];
        if let Some(percent) = config["creditUsagePercent"]
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.0)
        {
            windows.push(json!({"label":"当前周期","percent":percent,"resetsAt":config["currentPeriod"]["end"]}));
        }
    } else if agent == "kimi" {
        let number = |value: &Value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
        };
        for lane in
            std::iter::once(&value["usage"]).chain(value["limits"].as_array().into_iter().flatten())
        {
            let detail = lane.get("detail").unwrap_or(lane);
            let Some(limit) =
                number(&detail["limit"]).filter(|value| value.is_finite() && *value > 0.0)
            else {
                continue;
            };
            let Some(used) = number(&detail["used"])
                .or_else(|| number(&detail["remaining"]).map(|remaining| limit - remaining))
                .filter(|value| value.is_finite() && *value >= 0.0)
            else {
                continue;
            };
            let reset = ["resetAt", "reset_at", "resetTime", "reset_time"]
                .iter()
                .find_map(|key| lane.get(*key).or_else(|| detail.get(*key)))
                .cloned()
                .unwrap_or(Value::Null);
            windows.push(json!({"label":lane["name"].as_str().unwrap_or("用量"),"percent":used / limit * 100.0,"resetsAt":reset}));
        }
    }
    if matches!(agent, "kimi" | "grok") {
        return if windows.is_empty() {
            Err("用量服务没有返回可识别的额度窗口。".into())
        } else {
            Ok(windows)
        };
    }
    for (key, label) in if agent == "codex" {
        [
            ("primary_window", "主要额度"),
            ("secondary_window", "次要额度"),
        ]
    } else {
        [("five_hour", "5 小时"), ("seven_day", "7 天")]
    } {
        let window = if agent == "codex" {
            &value["rate_limit"][key]
        } else {
            &value[key]
        };
        if let Some(percent) = window[if agent == "codex" {
            "used_percent"
        } else {
            "utilization"
        }]
        .as_f64()
        {
            windows.push(json!({"label":label,"percent":percent,"seconds":window["limit_window_seconds"],"resetsAt":if agent == "codex" {window["reset_at"].clone()} else {window["resets_at"].clone()}}));
        }
    }
    if windows.is_empty() {
        return Err("用量服务没有返回可识别的额度窗口。".into());
    }
    Ok(windows)
}
#[tauri::command]
pub async fn agent_usage(
    agent: String,
    remote: Option<bool>,
    allow_keychain: Option<bool>,
) -> Result<Usage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = USAGE_LOCK
            .try_lock()
            .map_err(|_| "正在读取用量，请稍后重试。")?;
        if !["codex", "claude", "kimi", "grok"].contains(&agent.as_str()) {
            return Err("此 Agent 尚未提供可读取的用量记录。".into());
        }
        let home = agent_home(&agent)?;
        let mut usage = scan_usage(
            &agent,
            &home.join(if agent != "claude" {
                "sessions"
            } else {
                "projects"
            }),
        )?;
        if remote.unwrap_or(true) {
            match limits(&agent, &home, allow_keychain.unwrap_or(false)) {
                Ok(windows) => usage.windows = windows,
                Err(error) => usage.notice = Some(error),
            }
        }
        Ok(usage)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[cfg(test)]
mod tests {
    #[test]
    fn kimi_and_grok_usage_windows_and_logs() {
        use super::*;
        let kimi = parse_limits("kimi", &json!({"usage":{"limit":"100","remaining":25},"limits":[{"detail":{"limit":20,"used":5}}]})).unwrap();
        assert_eq!(kimi[0]["percent"], 75.0);
        assert_eq!(kimi[1]["percent"], 25.0);
        assert!(parse_limits("kimi", &json!({"usage":{"limit":0,"used":5}})).is_err());
        let grok = parse_limits("grok", &json!({"config":{"creditUsagePercent":32,"currentPeriod":{"end":"2026-10-01T00:00:00Z"}}})).unwrap();
        assert_eq!(grok[0]["percent"], 32.0);
        let fixture = tempfile::tempdir().unwrap();
        let now = chrono::Utc::now();
        std::fs::write(fixture.path().join("wire.jsonl"), json!({"time":now.timestamp_millis(),"type":"usage.record","usage":{"inputOther":10,"output":5,"inputCacheRead":2,"inputCacheCreation":3}}).to_string()).unwrap();
        let kimi = scan_usage("kimi", fixture.path()).unwrap();
        assert_eq!(
            (kimi.input, kimi.output, kimi.cache_read, kimi.cache_write),
            (10, 5, 2, 3)
        );
        let row = json!({"timestamp":now.timestamp(),"params":{"update":{"sessionUpdate":"turn_completed","prompt_id":"one","usage":{"inputTokens":20,"outputTokens":4,"cachedReadTokens":5,"cacheCreationTokens":3}}}}).to_string();
        std::fs::write(
            fixture.path().join("updates.jsonl"),
            format!("{row}\n{row}"),
        )
        .unwrap();
        let grok = scan_usage("grok", fixture.path()).unwrap();
        assert_eq!(
            (
                grok.records,
                grok.input,
                grok.output,
                grok.cache_read,
                grok.cache_write
            ),
            (1, 12, 4, 5, 3)
        );
    }
    use super::*;
    #[test]
    fn provider_windows_preserve_usage_and_reset_types() {
        let codex=parse_limits("codex", &json!({"rate_limit":{"primary_window":{"used_percent":42,"reset_at":1900000000,"limit_window_seconds":18000}}})).unwrap();
        assert_eq!(codex[0]["percent"], 42.0);
        assert_eq!(codex[0]["resetsAt"], 1900000000);
        let claude = parse_limits(
            "claude",
            &json!({"five_hour":{"utilization":15,"resets_at":"2026-09-24T10:00:00Z"}}),
        )
        .unwrap();
        assert_eq!(claude[0]["percent"], 15.0);
        assert_eq!(claude[0]["resetsAt"], "2026-09-24T10:00:00Z");
        assert!(parse_limits("codex", &json!({"unexpected":true})).is_err());
    }
    #[test]
    fn hooks_preserve_other_tools_and_reinstall_without_duplicates() {
        let original = json!({"theme":"dark","hooks":{"Stop":[{"hooks":[{"type":"command","command":"my-hook"}]}]}});
        let enabled = merge_hooks(
            original.clone(),
            "claude",
            "'reporter' --agent-report",
            true,
        )
        .expect("install");
        assert_eq!(
            enabled,
            merge_hooks(enabled.clone(), "claude", "'reporter' --agent-report", true)
                .expect("reinstall")
        );
        assert_eq!(enabled["theme"], "dark");
        assert_eq!(enabled["hooks"]["Stop"].as_array().expect("hooks").len(), 2);
        let removed =
            merge_hooks(enabled, "claude", "'reporter' --agent-report", false).expect("remove");
        assert_eq!(removed["hooks"]["Stop"], original["hooks"]["Stop"]);
        assert!(merge_hooks(json!({"hooks":[]}), "claude", "reporter", true).is_err());
    }
    #[test]
    fn token_tallies_do_not_count_cached_input_twice() {
        let mut usage = Usage::default();
        tally(
            &json!({"input_tokens":100,"cached_input_tokens":80,"output_tokens":12}),
            true,
            &mut usage,
        );
        assert_eq!((usage.input, usage.cache_read, usage.output), (20, 80, 12));
    }
    #[test]
    fn usage_logs_deduplicate_updates_and_exclude_old_records() {
        let root = std::env::temp_dir().join(format!(
            "uterm-usage-{}",
            chrono::Utc::now().timestamp_nanos_opt().expect("time")
        ));
        std::fs::create_dir_all(&root).expect("fixture");
        let now = chrono::Utc::now().to_rfc3339();
        let old = (chrono::Utc::now() - chrono::Duration::days(8)).to_rfc3339();
        let record = |timestamp: &str, total: u64| {
            json!({"timestamp":timestamp,"payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":total},"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":12}}}}).to_string()
        };
        std::fs::write(
            root.join("codex.jsonl"),
            [
                record(&now, 100),
                record(&now, 100),
                record(&now, 200),
                record(&old, 300),
            ]
            .join("\n"),
        )
        .expect("log");
        let usage = scan_usage("codex", &root).expect("usage");
        assert_eq!(
            (usage.records, usage.input, usage.output, usage.cache_read),
            (2, 40, 24, 160)
        );
        let claude = |output: u64| {
            json!({"timestamp":now,"message":{"id":"one-response","usage":{"input_tokens":5,"output_tokens":output,"cache_read_input_tokens":2}}}).to_string()
        };
        std::fs::write(root.join("claude.jsonl"), [claude(1), claude(9)].join("\n")).expect("log");
        let usage = scan_usage("claude", &root).expect("usage");
        assert_eq!(
            (usage.records, usage.input, usage.output, usage.cache_read),
            (1, 5, 9, 2)
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
