use anyhow::Result;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::Manager;
use uterm_core::java::{path_text, project_info};
pub use uterm_core::java::{
    probe, Configuration, JavaHome, MavenConfig, ProjectConfig, ProjectInfo,
};
use utermd_local::daemon::TaskSession;
pub(crate) fn managed_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    uterm_core::java::managed_root(&app.path().app_data_dir()?)
}

#[tauri::command]
pub async fn java_detect_jdks(app: tauri::AppHandle) -> Result<Vec<JavaHome>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::java::find_jdks(&app.path().app_data_dir()?)
    })
    .await
    .map_err(|_| "JAVA_OPERATION_FAILED".to_string())?
    .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub async fn java_register_jdk(
    app: tauri::AppHandle,
    home: String,
    remove: bool,
) -> Result<Vec<JavaHome>, String> {
    let operation = crate::content_operations::begin(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<JavaHome>> {
        let _operation = operation;
        uterm_core::java::register_jdk(&app.path().app_data_dir()?, &home, remove)?;
        use tauri::Emitter;
        app.emit("java-components-changed", ())?;
        uterm_core::java::find_jdks(&app.path().app_data_dir()?)
    })
    .await
    .map_err(|_| "JAVA_OPERATION_FAILED".to_string())?
    .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub async fn java_select_path(
    window: tauri::WebviewWindow,
    kind: String,
    directory: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if !["home", "settings", "repository"].contains(&kind.as_str()) {
        return Err("JAVA_CONFIG_INVALID".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = window.dialog().file().set_parent(&window);
        let path = Path::new(&directory);
        let initial = if path.is_dir() {
            Some(path)
        } else {
            path.parent().filter(|parent| parent.is_dir())
        };
        if let Some(initial) = initial {
            dialog = dialog.set_directory(initial);
        }
        let selected = if kind == "settings" {
            dialog
                .add_filter("settings.xml", &["xml"])
                .blocking_pick_file()
        } else {
            dialog.blocking_pick_folder()
        };
        selected
            .map(|file| {
                file.into_path()
                    .map(|path| path_text(&path))
                    .map_err(|_| "JAVA_PROJECT_INVALID".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|_| "JAVA_OPERATION_FAILED".to_string())?
}

#[tauri::command]
pub async fn java_configuration(
    app: tauri::AppHandle,
    directory: Option<String>,
) -> Result<Configuration, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::java::configuration(&app.path().app_data_dir()?, directory.as_deref(), true)
    })
    .await
    .map_err(|_| "JAVA_OPERATION_FAILED")?
    .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn java_save_configuration(
    app: tauri::AppHandle,
    directory: Option<String>,
    revision: String,
    global: Option<MavenConfig>,
    project: Option<ProjectConfig>,
) -> Result<Configuration, String> {
    let operation = crate::content_operations::begin(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        uterm_core::java::save_configuration(
            &app.path().app_data_dir()?,
            directory.as_deref(),
            &revision,
            global,
            project,
        )
    })
    .await
    .map_err(|_| "JAVA_OPERATION_FAILED")?
    .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn java_project(directory: String) -> Result<ProjectInfo, String> {
    tauri::async_runtime::spawn_blocking(move || project_info(&directory))
        .await
        .map_err(|_| "JAVA_OPERATION_FAILED")?
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn java_tasks(
    app: tauri::AppHandle,
    directory: String,
) -> Result<Vec<TaskSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::sessions::local_root(&app).map_err(anyhow::Error::msg)?;
        uterm_core::java::tasks(&path, &directory)
    })
    .await
    .map_err(|_| "JAVA_OPERATION_FAILED")?
    .map_err(|error: anyhow::Error| error.to_string())
}
#[tauri::command]
pub async fn java_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<crate::sessions::Sessions>>,
    directory: String,
    config: ProjectConfig,
    action: String,
    environment: HashMap<String, String>,
) -> Result<TaskSession, String> {
    let operation = crate::content_operations::begin(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let prepared = uterm_core::java::build_launch(
            &app.path().app_data_dir()?,
            &directory,
            &config,
            &action,
            environment,
        )?;
        let client = crate::sessions::local_client(&app, &state).map_err(anyhow::Error::msg)?;
        uterm_core::java::start(&client, prepared)
    })
    .await
    .map_err(|_| "JAVA_OPERATION_FAILED")?
    .map_err(|error: anyhow::Error| error.to_string())
}
#[tauri::command]
pub async fn java_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<crate::sessions::Sessions>>,
    id: String,
    generation: String,
    force: bool,
) -> Result<(), String> {
    let operation = crate::content_operations::begin(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let client = crate::sessions::local_client(&app, &state).map_err(anyhow::Error::msg)?;
        uterm_core::java::stop(&client, id, generation, force)
    })
    .await
    .map_err(|_| "JAVA_OPERATION_FAILED")?
    .map_err(|error: anyhow::Error| error.to_string())
}
