use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::Manager;

fn root(window: &tauri::WebviewWindow) -> Result<PathBuf, String> {
    let identity = option_env!("UTERM_QA_TRANSITION_ID").ok_or("Missing isolated identity")?;
    let root =
        PathBuf::from(option_env!("UTERM_QA_TRANSITION_ROOT").ok_or("Missing private root")?)
            .canonicalize()
            .map_err(|error| error.to_string())?;
    let temporary = std::env::temp_dir()
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if window.label() != "main"
        || window.app_handle().config().identifier != identity
        || !identity.starts_with("sh.uterm.desktop.qa.native.transition.")
        || root.parent() != Some(temporary.as_path())
        || !root
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with("uterm-native-qa-transition-"))
        || window
            .app_handle()
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .canonicalize()
            .map_err(|error| error.to_string())?
            != root
    {
        return Err("Historical QA bridge refuses another profile or window".into());
    }
    Ok(root)
}

#[tauri::command]
pub fn qa_legacy_context(window: tauri::WebviewWindow) -> Result<Value, String> {
    let root = root(&window)?;
    serde_json::from_slice(
        &std::fs::read(root.join("legacy-input.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn qa_legacy_host(window: tauri::WebviewWindow) -> Result<Value, String> {
    use utermd_local::daemon::{Client, Operation, Reply};
    let client = Client::connect(&root(&window)?.join("local-daemon-v1"))
        .map_err(|error| error.to_string())?;
    match client
        .request(Operation::HostStatus)
        .map_err(|error| error.to_string())?
    {
        Reply::HostStatus(status) => {
            serde_json::to_value(status).map_err(|error| error.to_string())
        }
        _ => Err("Unexpected historical host status".into()),
    }
}

#[tauri::command]
pub fn qa_legacy_export(
    window: tauri::WebviewWindow,
    values: Value,
    checks: Value,
) -> Result<(), String> {
    let root = root(&window)?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    let input: Value = serde_json::from_slice(
        &std::fs::read(root.join("legacy-input.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let phase = input["phase"]
        .as_str()
        .filter(|phase| ["before", "rollback"].contains(phase))
        .ok_or("Invalid historical phase")?;
    let entries = values
        .as_object()
        .ok_or("Expected frozen storage strings")?;
    if entries.len() > 100
        || entries
            .iter()
            .any(|(key, value)| !key.starts_with("uterm.") || !value.is_string())
    {
        return Err("Unexpected historical storage data".into());
    }
    let report = json!({"passed":checks.get("error").is_none(),"phase":phase,"baselineRelease":option_env!("UTERM_QA_TRANSITION_BASELINE"),
        "publishedInstallerBinary":false,"historicalApplicationWithLabelledQAOverlay":true,
        "pid":std::process::id(),"values":values,"checks":checks});
    let bytes = serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("Historical QA export is too large".into());
    }
    let mut staged = tempfile::NamedTempFile::new_in(&root).map_err(|error| error.to_string())?;
    use std::io::Write;
    staged
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    staged
        .persist(root.join(format!("legacy-{phase}.json")))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn qa_legacy_capture_ack(window: tauri::WebviewWindow, phase: String) -> Result<bool, String> {
    if !["before", "rollback"].contains(&phase.as_str()) {
        return Err("Invalid historical capture phase".into());
    }
    Ok(root(&window)?
        .join(format!("legacy-{phase}.capture-ack"))
        .is_file())
}
