use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

#[derive(Default)]
pub struct Lifecycle {
    pub active: AtomicBool,
    pub permit_exit: AtomicBool,
}

#[tauri::command]
pub fn shared_core_ready(state: tauri::State<'_, Lifecycle>) {
    state.active.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn shared_core_exit(app: tauri::AppHandle, state: tauri::State<'_, Lifecycle>) {
    state.permit_exit.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
pub async fn shared_core_request(app: tauri::AppHandle, request: String) -> Result<String, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("shared-state-v1");
    tauri::async_runtime::spawn_blocking(move || {
        let core = uterm_core::Core::open(root).map_err(|e| e.to_string())?;
        serde_json::to_string(&core.execute(request.as_bytes())).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn shared_core_export(window: tauri::WebviewWindow) -> Result<bool, String> {
    use std::io::Write;
    use tauri_plugin_dialog::DialogExt;
    let root = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("shared-state-v1");
    tauri::async_runtime::spawn_blocking(move || {
        let core = uterm_core::Core::open(root).map_err(|e| e.to_string())?;
        let response =
            core.execute(br#"{"version":1,"id":"rollback-export","method":"legacy.export"}"#);
        if let Some(error) = response.error {
            return Err(error.to_string());
        }
        let data = serde_json::to_vec_pretty(&response.result).map_err(|e| e.to_string())?;
        let selected = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name("uterm-legacy-export.json")
            .add_filter("JSON", &["json"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(false);
        };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        let parent = path.parent().ok_or("Invalid export directory")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temporary.write_all(&data).map_err(|e| e.to_string())?;
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        temporary.persist(path).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
