use anyhow::Result;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use uterm_core::credentials::{Credentials, SystemCredentials};
pub(crate) use uterm_core::ssh::auth::Prepared;
pub use uterm_core::ssh::auth::SshAuth;
use utermd_local::ssh::SshTarget;

fn credentials(app: &tauri::AppHandle) -> Result<Arc<dyn Credentials>> {
    Ok(Arc::new(SystemCredentials::new(format!(
        "{}.ssh",
        app.config().identifier
    ))?))
}
pub(crate) async fn prepare(app: &tauri::AppHandle, connection: &SshTarget) -> Result<Prepared> {
    let handle = app.clone();
    let window = app.get_webview_window("main");
    if connection.authentication.as_deref() == Some("password") && window.is_none() {
        anyhow::bail!("SSH_AUTH_FAILED");
    }
    app.state::<SshAuth>()
        .prepare(connection, credentials(app)?, move |prompt| {
            let Some(window) = &window else { return false };
            handle
                .dialog()
                .message(prompt)
                .parent(window)
                .title("SSH 主机指纹 / SSH host fingerprint")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "信任并连接 / Trust and connect".into(),
                    "取消 / Cancel".into(),
                ))
                .blocking_show()
        })
        .await
}
#[tauri::command]
pub async fn ssh_configure_auth(
    app: tauri::AppHandle,
    connection: SshTarget,
    password: Option<String>,
    remember: bool,
) -> Result<Option<String>, String> {
    app.state::<SshAuth>()
        .configure(
            credentials(&app).map_err(|e| e.to_string())?,
            connection,
            password,
            remember,
        )
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn ssh_forget_auth(
    app: tauri::AppHandle,
    reference: String,
    remember: bool,
) -> Result<(), String> {
    app.state::<SshAuth>()
        .forget(
            credentials(&app).map_err(|e| e.to_string())?,
            reference,
            remember,
        )
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn ssh_pick_identity(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_file()
            .map(|v| {
                v.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}
