use anyhow::Result;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use uterm_core::python::{
    configuration, display_path, inside, interpreters, project_info, root, save_configuration,
};
pub use uterm_core::python::{Configuration, Interpreter, ProjectInfo, RunConfig};
use utermd_local::daemon::TaskSession;

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(uterm_core::python::config_path(&app.path().app_data_dir()?))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "PYTHON_OPERATION_FAILED".to_string())?
        .map_err(|error| format!("{error:#}"))
}
#[tauri::command]
pub async fn python_configuration(
    app: tauri::AppHandle,
    directory: String,
) -> Result<Configuration, String> {
    blocking(move || configuration(&config_path(&app)?, &root(&directory)?)).await
}
#[tauri::command]
pub async fn python_save_configuration(
    app: tauri::AppHandle,
    directory: String,
    revision: String,
    config: RunConfig,
) -> Result<Configuration, String> {
    let operation = crate::content_operations::begin(&app)?;
    blocking(move || {
        let _operation = operation;
        save_configuration(&config_path(&app)?, &root(&directory)?, &revision, config)
    })
    .await
}
#[tauri::command]
pub async fn python_detect_interpreters(
    directory: String,
    selected: String,
) -> Result<Vec<Interpreter>, String> {
    blocking(move || Ok(interpreters(&root(&directory)?, &selected))).await
}
#[tauri::command]
pub async fn python_project(directory: String) -> Result<ProjectInfo, String> {
    blocking(move || project_info(&root(&directory)?)).await
}
#[tauri::command]
pub async fn python_select_path(
    window: tauri::WebviewWindow,
    directory: String,
    kind: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if !["interpreter", "script", "directory"].contains(&kind.as_str()) {
        return Err("PYTHON_CONFIG_INVALID".into());
    }
    blocking(move || {
        let root = root(&directory)?;
        let dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_directory(&root);
        let file = match kind.as_str() {
            "directory" => dialog.blocking_pick_folder(),
            "script" => dialog.add_filter("Python", &["py"]).blocking_pick_file(),
            _ => dialog.blocking_pick_file(),
        };
        file.map(|file| {
            let path = file
                .into_path()
                .map_err(|_| anyhow::anyhow!("PYTHON_PROJECT_INVALID"))?;
            if kind == "interpreter" {
                Ok(display_path(&path))
            } else {
                let path = inside(&root, &path.to_string_lossy())?;
                Ok(path.strip_prefix(&root)?.to_string_lossy().to_string())
            }
        })
        .transpose()
    })
    .await
}
#[tauri::command]
pub async fn python_tasks(
    app: tauri::AppHandle,
    directory: String,
) -> Result<Vec<TaskSession>, String> {
    blocking(move || {
        let path = crate::sessions::local_root(&app).map_err(anyhow::Error::msg)?;
        uterm_core::python::tasks(&path, &directory)
    })
    .await
}
#[tauri::command]
pub async fn python_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<crate::sessions::Sessions>>,
    directory: String,
    config: RunConfig,
    environment: HashMap<String, String>,
) -> Result<TaskSession, String> {
    let operation = crate::content_operations::begin(&app)?;
    let state = state.inner().clone();
    blocking(move || {
        let _operation = operation;
        let prepared = uterm_core::python::prepare(&directory, &config, environment)?;
        let client = crate::sessions::local_client(&app, &state).map_err(anyhow::Error::msg)?;
        uterm_core::python::start(&client, prepared)
    })
    .await
}
#[tauri::command]
pub async fn python_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<crate::sessions::Sessions>>,
    id: String,
    generation: String,
    force: bool,
) -> Result<(), String> {
    let operation = crate::content_operations::begin(&app)?;
    let state = state.inner().clone();
    blocking(move || {
        let _operation = operation;
        let client = crate::sessions::local_client(&app, &state).map_err(anyhow::Error::msg)?;
        uterm_core::python::stop(&client, id, generation, force)
    })
    .await
}
