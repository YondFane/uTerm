use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::Manager;

pub const IDENTIFIER: &str = "sh.uterm.desktop.qa.sharedstate";

pub fn cleanup() -> Result<(), String> {
    use utermd_local::daemon::{Client, Operation, Reply};
    let directory = root()?.join("data/local-daemon-v1");
    if !directory.join("endpoint.json").exists() {
        return Ok(());
    }
    let client = Client::connect(&directory).map_err(|e| e.to_string())?;
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
        .ok_or_else(|| format!("Missing {name}"))
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
    ]
    .contains(&phase.as_str())
    {
        return Err("Invalid QA phase".into());
    }
    Ok(json!({
        "phase": phase, "root": root, "project":root.join("project"), "backup": argument("--qa-backup").ok(),
        "head": option_env!("UTERM_QA_HEAD"), "tested": option_env!("UTERM_QA_TESTED"),
        "sourceTreeDirty":option_env!("UTERM_QA_DIRTY"),
        "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH,
        "ready": app.state::<crate::shared_core::Lifecycle>().active.load(std::sync::atomic::Ordering::SeqCst)
    }))
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
pub async fn qa_scene(app: tauri::AppHandle, name: String, value: Value) -> Result<(), String> {
    let root = check(&app)?;
    if name.is_empty()
        || name.len() > 50
        || !name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
    {
        return Err("Invalid QA scene".into());
    }
    let phase = argument("--qa-phase")?;
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
        for _ in 0..300 {
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

#[tauri::command]
pub fn qa_request_exit(app: tauri::AppHandle) -> Result<(), String> {
    check(&app)?;
    app.exit(0);
    Ok(())
}
