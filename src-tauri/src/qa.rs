use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::Manager;

pub const IDENTIFIER: &str = "sh.uterm.desktop.qa.sharedstate";

#[derive(Default)]
pub struct UpdateTransferFixture(
    std::sync::Mutex<Option<(String, uterm_core::ssh::files::TransferGuard)>>,
);

#[tauri::command]
pub fn qa_update_transfer(app: tauri::AppHandle, action: String) -> Result<Value, String> {
    if !updates_enabled(&app) {
        return Err("Unavailable outside isolated update QA".into());
    }
    let state = app.state::<UpdateTransferFixture>();
    let mut fixture = state
        .0
        .lock()
        .map_err(|_| "QA transfer fixture unavailable")?;
    let files = app.state::<crate::ssh::SshFiles>();
    match action.as_str() {
        "start" => {
            if fixture.is_some() {
                return Err("QA transfer already exists".into());
            }
            let id = uuid::Uuid::new_v4().to_string();
            let guard = files
                .begin_transfer(&id)
                .map_err(|error| error.to_string())?;
            *fixture = Some((id, guard));
        }
        "cancel" => {
            let (id, _) = fixture.as_ref().ok_or("No QA transfer")?;
            files.cancel(id).map_err(|error| error.to_string())?;
        }
        "complete" => {
            fixture.take();
        }
        _ => return Err("Invalid QA transfer action".into()),
    }
    // Simulate only the worker lifetime; use the real transfer registry and cancellation rules.
    // 仅模拟工作任务生命周期，使用真实传输登记与取消规则。
    Ok(json!({"busy": files.busy(), "simulatedWorker":true}))
}

pub fn control_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = check(app)?;
    Ok(if argument("--qa-phase")? == "input-viewer" {
        root.join("input-viewer-control")
    } else {
        root.join("data")
    })
}

pub fn cleanup() -> Result<(), String> {
    use utermd_local::daemon::{Client, Operation, Reply};
    let directory = root()?.join("data/local-daemon-v1");
    if !directory.join("endpoint.json").exists() {
        return Ok(());
    }
    let client = Client::connect(&directory).map_err(|e| e.to_string())?;
    if let Reply::HostStatus(status) = client
        .request(Operation::HostStatus)
        .map_err(|e| e.to_string())?
    {
        for session in status.sessions {
            client
                .request(Operation::Close {
                    id: session.spec.id,
                    generation: session.generation,
                })
                .map_err(|e| e.to_string())?;
        }
    }
    match client
        .request(Operation::ShutdownIfIdle)
        .map_err(|e| e.to_string())?
    {
        Reply::Done => Ok(()),
        _ => Err("Unexpected isolated host shutdown reply".into()),
    }
}

fn argument(name: &str) -> Result<String, String> {
    let arguments: Vec<_> = std::env::args().collect();
    arguments
        .windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
        // The real NSIS updater relaunches without QA arguments; only this compiled fixture has a fallback.
        // 真实 NSIS 更新器重启时不带 QA 参数，仅专门编译的测试包提供此回退。
        .or_else(|| match (name, option_env!("UTERM_QA_UPDATES_ROOT")) {
            ("--qa-data-root", Some(root)) => Some(root.into()),
            ("--qa-phase", Some(_)) => Some("updates".into()),
            _ => None,
        })
        .ok_or_else(|| format!("Missing {name}"))
}

pub fn updates_enabled(app: &tauri::AppHandle) -> bool {
    cfg!(windows)
        && argument("--qa-phase").as_deref() == Ok("updates")
        && check(app).is_ok()
        && app
            .config()
            .plugins
            .0
            .get("updater")
            .is_some_and(updates_config_allowed)
}

fn updates_config_allowed(value: &Value) -> bool {
    let Some(endpoints) = value["endpoints"].as_array() else {
        return false;
    };
    value["requireSignedVersion"] == true
        && value["dangerousAcceptInvalidCerts"].as_bool() != Some(true)
        && value["dangerousAcceptInvalidHostnames"].as_bool() != Some(true)
        && value["allowDowngrades"].as_bool() != Some(true)
        && value["pubkey"].as_str().is_some_and(|key| !key.is_empty())
        && endpoints.len() == 1
        && endpoints[0].as_str().is_some_and(|endpoint| {
            if !endpoint.starts_with("http://127.0.0.1:") {
                return false;
            }
            tauri::Url::parse(endpoint).is_ok_and(|url| {
                url.scheme() == "http"
                    && url.host_str() == Some("127.0.0.1")
                    && url.port().is_some_and(|port| port != 0)
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.path() == "/manifest.json"
                    && url.query().is_none()
                    && url.fragment().is_none()
            })
        })
}

#[cfg(test)]
mod update_tests {
    use super::*;

    #[test]
    fn updater_qa_requires_literal_loopback_and_strict_signed_versions() {
        let good = json!({"endpoints":["http://127.0.0.1:48371/manifest.json"],
            "pubkey":"public-test-key", "requireSignedVersion":true});
        assert!(updates_config_allowed(&good));
        assert!(updates_url_allowed(
            &good,
            &tauri::Url::parse("http://127.0.0.1:48371/update.exe?case=good").unwrap()
        ));
        for download in [
            "https://example.com/update.exe",
            "http://127.0.0.1:48372/update.exe",
            "http://127.0.0.1:48371/other.exe",
            "http://user@127.0.0.1:48371/update.exe",
        ] {
            assert!(
                !updates_url_allowed(&good, &tauri::Url::parse(download).unwrap()),
                "{download}"
            );
        }
        for endpoint in [
            "https://example.com/manifest.json",
            "http://localhost:48371/manifest.json",
            "http://2130706433:48371/manifest.json",
            "http://127.0.0.1:48371/other",
            "http://user@127.0.0.1:48371/manifest.json",
            "http://127.0.0.1:48371/manifest.json?q=1",
        ] {
            let mut bad = good.clone();
            bad["endpoints"] = json!([endpoint]);
            assert!(!updates_config_allowed(&bad), "{endpoint}");
        }
        for (key, value) in [
            ("requireSignedVersion", false),
            ("dangerousAcceptInvalidCerts", true),
            ("dangerousAcceptInvalidHostnames", true),
            ("allowDowngrades", true),
        ] {
            let mut bad = good.clone();
            bad[key] = json!(value);
            assert!(!updates_config_allowed(&bad), "{key}");
        }
        let mut bad = good;
        bad["endpoints"] = json!([]);
        assert!(!updates_config_allowed(&bad));
    }
}

pub fn updates_download_allowed(app: &tauri::AppHandle, download: &tauri::Url) -> bool {
    if !updates_enabled(app) {
        return false;
    }
    updates_url_allowed(&app.config().plugins.0["updater"], download)
}

fn updates_url_allowed(config: &Value, download: &tauri::Url) -> bool {
    let Some(endpoint) = config["endpoints"][0].as_str() else {
        return false;
    };
    tauri::Url::parse(endpoint).is_ok_and(|endpoint| {
        download.origin() == endpoint.origin()
            && download.path() == "/update.exe"
            && download.username().is_empty()
            && download.password().is_none()
            && download.fragment().is_none()
    })
}

#[tauri::command]
pub fn qa_updates(
    app: tauri::AppHandle,
    mode: String,
    checkpoint: Option<Value>,
) -> Result<Value, String> {
    let root = check(&app)?;
    if !updates_enabled(&app) {
        return Err("Updates fixture is unavailable".into());
    }
    std::fs::write(
        root.join("updates-current-pid"),
        std::process::id().to_string(),
    )
    .map_err(|e| e.to_string())?;
    match mode.as_str() {
        "context" => {}
        "checkpoint" => {
            let bytes = serde_json::to_vec(&checkpoint.ok_or("Missing update checkpoint")?)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 16_384 {
                return Err("Oversized update checkpoint".into());
            }
            std::fs::write(root.join("updates-checkpoint.json"), bytes)
                .map_err(|e| e.to_string())?;
        }
        "good" | "bad-signature" | "wrong-arch" | "old-version" | "offline" | "interrupted"
        | "automatic" => {
            std::fs::write(root.join("updates-mode"), &mode).map_err(|e| e.to_string())?;
        }
        _ => return Err("Unknown updates fixture mode".into()),
    }
    Ok(
        json!({"version":app.package_info().version.to_string(), "pid":std::process::id(),
        "checkpoint":std::fs::read(root.join("updates-checkpoint.json")).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())}),
    )
}

pub fn root() -> Result<PathBuf, String> {
    let root = PathBuf::from(argument("--qa-data-root")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let temporary = std::env::temp_dir()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if root.parent() != Some(temporary.as_path())
        || !root
            .file_name()
            .and_then(|v| v.to_str())
            .is_some_and(|s| s.starts_with("uterm-tauri-qa-"))
    {
        return Err("QA root must be a dedicated direct child of the temporary directory".into());
    }
    Ok(root)
}

fn check(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if app.config().identifier != IDENTIFIER {
        return Err("Unexpected QA identifier".into());
    }
    let root = root()?;
    if app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?
        != root.join("data")
    {
        return Err("QA data override was not applied".into());
    }
    Ok(root)
}

#[tauri::command]
pub async fn qa_host_status(app: tauri::AppHandle) -> Result<Value, String> {
    let directory = check(&app)?.join("data/local-daemon-v1");
    tauri::async_runtime::spawn_blocking(move || {
        use utermd_local::daemon::{Client, Operation, Reply};
        let client = Client::connect(&directory).map_err(|error| error.to_string())?;
        let Reply::HostStatus(status) = client
            .request(Operation::HostStatus)
            .map_err(|error| error.to_string())?
        else {
            return Err("Unexpected QA host status reply".into());
        };
        serde_json::to_value(status).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn qa_context(app: tauri::AppHandle) -> Result<Value, String> {
    let root = check(&app)?;
    let phase = argument("--qa-phase")?;
    if ![
        "initial",
        "reopen",
        "recover",
        "editor-checkpoint",
        "editor-reopen",
        "git",
        "ssh",
        "ssh-reopen",
        "redis",
        "database",
        "agents",
        "input-owner",
        "input-viewer",
        "package",
        "performance",
        "ui-parity",
        "updates",
    ]
    .contains(&phase.as_str())
    {
        return Err("Invalid QA phase".into());
    }
    Ok(json!({
        "identifier": app.config().identifier,
        "phase": phase, "root": root, "project": if phase == "ui-parity" { root.join("parity/project") } else { root.join("project") }, "backup": argument("--qa-backup").ok(),
        "head": option_env!("UTERM_QA_HEAD"), "tested": option_env!("UTERM_QA_TESTED"),
        "sourceTreeDirty":option_env!("UTERM_QA_DIRTY"),
        "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH,
        "performanceLong": std::env::args().any(|argument| argument == "--qa-performance-long"),
        "ready": app.state::<crate::shared_core::Lifecycle>().active.load(std::sync::atomic::Ordering::SeqCst)
    }))
}

#[tauri::command]
pub fn qa_database_fixture(app: tauri::AppHandle) -> Result<Value, String> {
    let root = check(&app)?;
    if !["database", "performance"].contains(&argument("--qa-phase")?.as_str())
        && !updates_enabled(&app)
    {
        return Err("Database fixture is unavailable in this QA phase".into());
    }
    // Keep private authentication outside screenshot context and production commands.
    // 私有认证不进入截图上下文或生产命令。
    serde_json::from_slice(
        &std::fs::read(root.join("database-fixture.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn qa_redis_fixture(app: tauri::AppHandle) -> Result<Value, String> {
    let root = check(&app)?;
    if argument("--qa-phase")? != "redis" {
        return Err("Redis fixture is unavailable in this QA phase".into());
    }
    // Keep private credentials out of the public screenshot context.
    // 私有凭据不进入公开截图上下文。
    serde_json::from_slice(
        &std::fs::read(root.join("redis-fixture.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn qa_ssh_fixture(app: tauri::AppHandle) -> Result<Value, String> {
    let root = check(&app)?;
    let phase = argument("--qa-phase")?;
    if phase != "ssh" && phase != "ssh-reopen" {
        return Err("SSH fixture is unavailable in this QA phase".into());
    }
    // Keep private credentials out of qa_context, which is embedded in screenshot reports.
    // 私有凭据不进入 qa_context，该上下文会写入截图报告。
    let mut fixture: Value = serde_json::from_slice(
        &std::fs::read(root.join("ssh-fixture.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if phase == "ssh-reopen" {
        let previous: Value = serde_json::from_slice(
            &std::fs::read(root.join("evidence/ssh-ssh-terminal.json"))
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fixture["previous"] = previous["checks"].clone();
    }
    Ok(fixture)
}

#[tauri::command]
pub async fn qa_external_settings(app: tauri::AppHandle) -> Result<Value, String> {
    let root = check(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let core =
            uterm_core::Core::open(root.join("data/shared-state-v1")).map_err(|e| e.to_string())?;
        let current = core.execute(br#"{"version":1,"id":"qa-read","method":"snapshot.read"}"#);
        if let Some(error) = current.error {
            return Err(error.to_string());
        }
        let revision = current.result.ok_or("Missing snapshot")?["revision"].clone();
        let request = json!({"version":1,"id":"qa-external","method":"settings.patch",
            "params":{"expectedRevision":revision,"patch":{"fontSize":21,"fileFontSize":17}}});
        let reply = core.execute(&serde_json::to_vec(&request).map_err(|e| e.to_string())?);
        if let Some(error) = reply.error {
            return Err(error.to_string());
        }
        reply.result.ok_or_else(|| "Missing saved snapshot".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn qa_performance_window(app: tauri::AppHandle, width: u32, height: u32) -> Result<(), String> {
    check(&app)?;
    if !["performance", "ui-parity"].contains(&argument("--qa-phase")?.as_str())
        || !(640..=1600).contains(&width)
        || !(420..=1200).contains(&height)
    {
        return Err("Invalid isolated performance window size".into());
    }
    let window = app.get_webview_window("main").ok_or("Missing QA window")?;
    window.unmaximize().map_err(|error| error.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| error.to_string())
}

fn valid_scene_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 50
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

#[tauri::command]
pub async fn qa_scene(app: tauri::AppHandle, name: String, value: Value) -> Result<(), String> {
    let root = check(&app)?;
    if !valid_scene_name(&name) {
        return Err("Invalid QA scene".into());
    }
    let phase = argument("--qa-phase")?;
    if phase == "performance" && name == "performance-progress" {
        let measured = value
            .get("phase")
            .and_then(Value::as_str)
            .ok_or("Missing performance phase")?;
        if ![
            "terminal",
            "file-service",
            "file-setup",
            "replay",
            "idle-soak",
            "cleanup",
            "slow-consumer",
            "tui",
            "database",
            "database-setup",
            "capture",
        ]
        .contains(&measured)
        {
            return Err("Invalid performance phase".into());
        }
        let status = qa_host_status(app.clone()).await?;
        let mut heartbeat = value;
        heartbeat["hostPID"] = status["pid"].clone();
        let mut temporary =
            tempfile::NamedTempFile::new_in(&root).map_err(|error| error.to_string())?;
        serde_json::to_writer(temporary.as_file_mut(), &heartbeat)
            .map_err(|error| error.to_string())?;
        temporary
            .persist(root.join("performance-phase.json"))
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    let bytes = serde_json::to_vec_pretty(
        &json!({"context":qa_context(app)?, "scene":name,"checks":value}),
    )
    .map_err(|e| e.to_string())?;
    if bytes.len() > 32768 {
        return Err("Oversized QA report".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let evidence = root.join("evidence");
        std::fs::create_dir_all(&evidence).map_err(|e| e.to_string())?;
        let stem = format!("{phase}-{name}");
        let temporary = evidence.join(format!("{stem}.tmp"));
        std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(temporary, evidence.join(format!("{stem}.json")))
            .map_err(|e| e.to_string())?;
        let ack = evidence.join(format!("{stem}.ack"));
        // Native window discovery/capture can take over 30 seconds on Windows CI.
        // Windows CI 的原生窗口发现及截图可能超过30秒。
        for _ in 0..900 {
            if ack.exists() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err("QA screenshot runner did not acknowledge the scene".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::valid_scene_name;

    #[test]
    fn screenshot_scene_names_retain_locale_and_dimensions_without_path_components() {
        for name in [
            "workspace-en-dark-1100",
            "workspace-zh-Hans-light-640",
            "settings-appearance-zh-Hans-light-660",
            "performance-progress",
        ] {
            assert!(valid_scene_name(name), "{name}");
        }
        for name in [
            "",
            "../outside",
            "scene/child",
            "scene\\child",
            "scene:stream",
            "scene.txt",
            "scene\0",
            "scene name",
            "场景",
        ] {
            assert!(!valid_scene_name(name), "{name:?}");
        }
        assert!(valid_scene_name(&"a".repeat(50)));
        assert!(!valid_scene_name(&"a".repeat(51)));
    }
}

#[tauri::command]
pub fn qa_request_exit(app: tauri::AppHandle) -> Result<(), String> {
    check(&app)?;
    eprintln!("QA lifecycle: ordinary exit requested");
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn qa_shutdown_idle(app: tauri::AppHandle) -> Result<(), String> {
    let directory = check(&app)?.join("data/local-daemon-v1");
    tauri::async_runtime::spawn_blocking(move || {
        use utermd_local::daemon::{Client, Operation, Reply};
        if !directory.join("endpoint.json").exists() {
            return Ok(());
        }
        let client = Client::connect(&directory).map_err(|error| error.to_string())?;
        match client
            .request(Operation::ShutdownIfIdle)
            .map_err(|error| error.to_string())?
        {
            Reply::Done => Ok(()),
            _ => Err("Owned QA host did not confirm idle shutdown".into()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}
