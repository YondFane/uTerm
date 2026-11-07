use std::sync::Arc;
use tauri::Manager;
pub use uterm_core::redis::{Config, RedisState, Request};

fn host(app: &tauri::AppHandle) -> uterm_core::redis::Host {
    let prepare = app.clone();
    uterm_core::redis::Host {
        state: app.state::<RedisState>().inner().clone(),
        identifier: app.config().identifier.clone(),
        prepare_ssh: Arc::new(move |target| {
            let app = prepare.clone();
            Box::pin(async move { crate::ssh_auth::prepare(&app, &target).await })
        }),
    }
}
fn fail(error: impl std::fmt::Display) -> String {
    error.to_string()
}
#[tauri::command]
pub async fn redis_credential(
    app: tauri::AppHandle,
    config: Config,
    password: Option<String>,
    remove: bool,
) -> Result<Option<String>, String> {
    uterm_core::redis::redis_credential(host(&app), config, password, remove).await
}
#[tauri::command]
pub async fn redis_connect(
    app: tauri::AppHandle,
    config: Config,
    password: Option<String>,
) -> Result<serde_json::Value, String> {
    uterm_core::redis::redis_connect(host(&app), config, password).await
}
#[tauri::command]
pub async fn redis_reconnect(
    app: tauri::AppHandle,
    handle: String,
) -> Result<serde_json::Value, String> {
    uterm_core::redis::redis_reconnect(host(&app), handle).await
}
#[tauri::command]
pub async fn redis_request(
    app: tauri::AppHandle,
    handle: String,
    request: Request,
) -> Result<serde_json::Value, String> {
    uterm_core::redis::redis_request(host(&app), handle, request).await
}
#[tauri::command]
pub async fn redis_writable(
    app: tauri::AppHandle,
    handle: String,
    writable: bool,
) -> Result<(), String> {
    uterm_core::redis::redis_writable(host(&app), handle, writable).await
}
#[tauri::command]
pub async fn redis_disconnect(app: tauri::AppHandle, handle: String) {
    uterm_core::redis::redis_disconnect(host(&app), handle).await
}
#[tauri::command]
pub fn redis_guard(app: tauri::AppHandle, id: String, active: bool) -> Result<(), String> {
    uterm_core::redis::redis_guard(host(&app), id, active)
}

#[tauri::command]
pub fn redis_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub async fn redis_pick_ca(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("PEM", &["pem", "crt", "cer"])
            .blocking_pick_file()
            .map(|path| {
                path.into_path()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(fail)
            })
            .transpose()
    })
    .await
    .map_err(fail)?
}
