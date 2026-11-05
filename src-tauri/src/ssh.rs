use anyhow::{anyhow, bail, Result};
pub use files::{RemoteListing, RemoteRoot, SshFiles, TransferProgress};
use tauri::ipc::Channel;
use uterm_core::ssh::files;
use utermd_local::ssh::SshTarget;

async fn ensure(app: &tauri::AppHandle, state: &SshFiles, root: &RemoteRoot) -> Result<(), String> {
    if !state.contains(root).await.map_err(|e| e.to_string())? {
        let prepared = crate::ssh_auth::prepare(app, &root.connection)
            .await
            .map_err(|e| e.to_string())?;
        state
            .open(root.connection.clone(), Some(root.clone()), prepared)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub async fn ssh_resolve(connection: SshTarget) -> Result<uterm_core::ssh::Resolution, String> {
    uterm_core::ssh::effective_target(&connection)
        .await
        .map(Into::into)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn ssh_info() -> Result<uterm_core::ssh::Info, String> {
    tauri::async_runtime::spawn_blocking(uterm_core::ssh::info)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn ssh_files_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshFiles>,
    connection: SshTarget,
    expected: Option<RemoteRoot>,
) -> Result<RemoteRoot, String> {
    let prepared = crate::ssh_auth::prepare(&app, &connection)
        .await
        .map_err(|e| e.to_string())?;
    state
        .open(connection, expected, prepared)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn ssh_files_disconnect(
    state: tauri::State<'_, SshFiles>,
    connection_id: String,
) -> Result<(), String> {
    state
        .disconnect(&connection_id)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn ssh_files_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshFiles>,
    root: RemoteRoot,
    path: String,
    hidden: bool,
) -> Result<RemoteListing, String> {
    ensure(&app, &state, &root).await?;
    files::ssh_files_list(&state, root, path, hidden).await
}
#[tauri::command]
pub async fn ssh_file_read(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshFiles>,
    root: RemoteRoot,
    path: String,
) -> Result<crate::files::Document, String> {
    ensure(&app, &state, &root).await?;
    files::ssh_file_read(&state, root, path).await
}
#[tauri::command]
pub async fn ssh_file_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshFiles>,
    root: RemoteRoot,
    path: String,
    text: String,
    expected: String,
    force: bool,
) -> Result<String, String> {
    ensure(&app, &state, &root).await?;
    files::ssh_file_save(&state, root, path, text, expected, force).await
}
#[tauri::command]
pub async fn ssh_file_mutate(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshFiles>,
    root: RemoteRoot,
    path: String,
    action: String,
    name: String,
) -> Result<(), String> {
    ensure(&app, &state, &root).await?;
    files::ssh_file_mutate(&state, root, path, action, name).await
}
#[tauri::command]
pub async fn ssh_transfer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SshFiles>,
    root: RemoteRoot,
    path: String,
    direction: String,
    id: String,
    overwrite: bool,
    events: Channel<TransferProgress>,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    let guard = state.begin_transfer(&id).map_err(|e| e.to_string())?;
    async {
        let paths = tauri::async_runtime::spawn_blocking(move || {
            let dialog = window.dialog().file().set_parent(&window);
            let selected = if direction == "upload" {
                dialog.blocking_pick_files()
            } else if direction == "download" {
                dialog
                    .set_file_name(path.rsplit('/').next().unwrap_or("download"))
                    .blocking_save_file()
                    .map(|path| vec![path])
            } else {
                return Err(anyhow!("SSH_INVALID_ACTION"));
            };
            Ok::<_, anyhow::Error>((
                selected
                    .map(|paths| {
                        paths
                            .into_iter()
                            .map(|path| path.into_path().map_err(|error| anyhow!("{error}")))
                            .collect::<Result<Vec<_>>>()
                    })
                    .transpose()?,
                direction,
                path,
            ))
        })
        .await??;
        let (Some(paths), direction, path) = paths else {
            bail!("SSH_TRANSFER_CANCELLED");
        };
        ensure(&app, &state, &root)
            .await
            .map_err(anyhow::Error::msg)?;
        let events = move |value| {
            events
                .send(value)
                .map_err(|error| anyhow::anyhow!("{error}"))
        };
        state
            .transfer(&root, &path, &direction, paths, overwrite, &guard, &events)
            .await?;
        Ok::<_, anyhow::Error>(())
    }
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn ssh_transfer_cancel(state: tauri::State<'_, SshFiles>, id: String) -> Result<(), String> {
    state.cancel(&id).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn ssh_transfer_cancel_all(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshFiles>,
    exit: bool,
) -> Result<(), String> {
    state
        .cancel_and_disconnect()
        .await
        .map_err(|e| e.to_string())?;
    if exit {
        app.exit(0);
    }
    Ok(())
}
