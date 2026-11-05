use anyhow::{Context, Result};
use serde_json::Value;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
pub use uterm_core::database::{Config, DatabaseState};

pub(crate) fn host(app: &tauri::AppHandle) -> Result<uterm_core::database::Host, String> {
    let prepare_app = app.clone();
    let pick_app = app.clone();
    let event_app = app.clone();
    Ok(uterm_core::database::Host {
        database: app.state::<DatabaseState>().inner().clone(),
        components: app
            .state::<crate::database_components::Components>()
            .inner()
            .clone(),
        data: app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?,
        cache: app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?,
        identifier: app.config().identifier.clone(),
        prepare_ssh: Arc::new(move |target| {
            let app = prepare_app.clone();
            Box::pin(async move { crate::ssh_auth::prepare(&app, &target).await })
        }),
        pick_file: Arc::new(move || {
            let app = pick_app.clone();
            Box::pin(async move {
                let window = app
                    .get_webview_window("main")
                    .context("DB_OPERATION_FAILED")?;
                tokio::task::spawn_blocking(move || {
                    window
                        .dialog()
                        .file()
                        .set_parent(&window)
                        .blocking_pick_file()
                        .map(|file| {
                            file.into_path()
                                .map_err(|_| anyhow::anyhow!("DB_INVALID_REQUEST"))
                        })
                        .transpose()
                })
                .await?
            })
        }),
        events: Arc::new(move |event, payload| {
            event_app.emit(event, payload)?;
            Ok(())
        }),
    })
}

#[tauri::command]
pub async fn database_connect(
    app: tauri::AppHandle,
    config: Config,
    password: Option<String>,
) -> Result<Value, String> {
    uterm_core::database::database_connect(host(&app)?, config, password).await
}
#[tauri::command]
pub async fn database_request(
    app: tauri::AppHandle,
    handle: String,
    request: Value,
) -> Result<Value, String> {
    uterm_core::database::database_request(host(&app)?, handle, request).await
}
#[tauri::command]
pub async fn database_disconnect(
    app: tauri::AppHandle,
    handle: String,
    discard: bool,
) -> Result<(), String> {
    uterm_core::database::database_disconnect(host(&app)?, handle, discard).await
}
#[tauri::command]
pub fn database_guard(app: tauri::AppHandle, id: String, dirty: bool) -> Result<(), String> {
    uterm_core::database::database_guard(host(&app)?, id, dirty)
}
#[tauri::command]
pub fn database_exit(app: tauri::AppHandle) -> Result<(), String> {
    uterm_core::database::database_prepare_exit(host(&app)?)?;
    app.exit(0);
    Ok(())
}
#[tauri::command]
pub async fn database_credential(
    app: tauri::AppHandle,
    config: Config,
    password: Option<String>,
    remove: bool,
) -> Result<Option<String>, String> {
    uterm_core::database::database_credential(host(&app)?, config, password, remove).await
}

#[tauri::command]
pub async fn database_export_sql(
    window: tauri::WebviewWindow,
    sql: String,
) -> Result<bool, String> {
    if sql.len() > 1048576 {
        return Err("DB_INPUT_LIMIT".into());
    }
    export_text(window, sql, "query.sql", "sql").await
}

#[tauri::command]
pub async fn database_export_result(
    window: tauri::WebviewWindow,
    data: String,
    format: String,
) -> Result<bool, String> {
    if data.len() > 8 * 1024 * 1024 {
        return Err("DB_INPUT_LIMIT".into());
    }
    match format.as_str() {
        "csv" => export_text(window, data, "results.csv", "csv").await,
        "json" => export_text(window, data, "results.json", "json").await,
        _ => Err("DB_INVALID_REQUEST".into()),
    }
}

async fn export_text(
    window: tauri::WebviewWindow,
    data: String,
    name: &str,
    extension: &str,
) -> Result<bool, String> {
    use std::io::Write;
    use tauri_plugin_dialog::DialogExt;
    let name = name.to_owned();
    let extension = extension.to_owned();
    tauri::async_runtime::spawn_blocking(move || -> Result<bool> {
        let selected = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(name)
            .add_filter(extension.to_uppercase(), &[extension.as_str()])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(false);
        };
        let path = selected
            .into_path()
            .map_err(|_| anyhow::anyhow!("DB_OPERATION_FAILED"))?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(path.parent().context("DB_OPERATION_FAILED")?)?;
        temporary.write_all(data.as_bytes())?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(path)
            .map_err(|_| anyhow::anyhow!("DB_OPERATION_FAILED"))?;
        Ok(true)
    })
    .await
    .map_err(|_| "DB_OPERATION_FAILED")?
    .map_err(|_| "DB_OPERATION_FAILED".into())
}
