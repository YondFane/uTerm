use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{ipc::Channel, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates(tauri::async_runtime::Mutex<Pending>);
#[derive(Default)]
struct Pending {
    update: Option<Update>,
    downloaded: Option<Vec<u8>>,
}
#[derive(Serialize)]
pub struct Availability {
    enabled: bool,
    version: String,
    notes: Option<String>,
    downloaded: bool,
}
#[derive(Clone, Serialize)]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}
fn enabled(app: &tauri::AppHandle) -> bool {
    !cfg!(debug_assertions)
        && app.config().identifier == "sh.uterm.desktop"
        && app.config().plugins.0.contains_key("updater")
}
fn require_enabled(app: &tauri::AppHandle) -> Result<(), String> {
    if !enabled(app) {
        return Err("此构建未启用在线更新。请使用正式渠道安装包。".into());
    }
    Ok(())
}
fn availability(app: &tauri::AppHandle, pending: &Pending) -> Availability {
    Availability {
        enabled: enabled(app),
        version: pending
            .update
            .as_ref()
            .map(|u| u.version.clone())
            .unwrap_or_default(),
        notes: pending.update.as_ref().and_then(|u| u.body.clone()),
        downloaded: pending.downloaded.is_some(),
    }
}
#[tauri::command]
pub async fn update_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<Availability, String> {
    let pending = state.0.try_lock().map_err(|_| "更新操作正在进行。")?;
    Ok(availability(&app, &pending))
}
#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<Availability, String> {
    require_enabled(&app)?;
    let mut pending = state.0.try_lock().map_err(|_| "更新操作正在进行。")?;
    let mut update = app
        .updater_builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(update) = &mut update {
        update.timeout = Some(std::time::Duration::from_secs(600));
    }
    pending.update = update;
    pending.downloaded = None;
    Ok(availability(&app, &pending))
}
#[tauri::command]
pub async fn update_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
    events: Channel<Progress>,
) -> Result<(), String> {
    require_enabled(&app)?;
    let mut pending = state.0.try_lock().map_err(|_| "更新操作正在进行。")?;
    let update = pending.update.as_ref().ok_or("请先检查更新。")?;
    let mut downloaded = 0;
    let bytes = update
        .download(
            |count, total| {
                downloaded += count as u64;
                if let Err(error) = events.send(Progress { downloaded, total }) {
                    eprintln!("Update progress: {error}");
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    pending.downloaded = Some(bytes);
    Ok(())
}
#[tauri::command]
pub async fn update_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<(), String> {
    require_enabled(&app)?;
    let pending = state.0.try_lock().map_err(|_| "更新操作正在进行。")?;
    let update = pending.update.as_ref().ok_or("请先检查更新。")?;
    let bytes = pending.downloaded.as_ref().ok_or("请先下载更新。")?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("local-daemon-v1");
    tauri::async_runtime::spawn_blocking(move || {
        utermd_local::daemon::ensure_update_safe(&root).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    // Windows installers can exit the process directly, bypassing ExitRequested.
    // Windows 安装器可能直接退出进程，绕过退出事件，因此必须在安装前检查编辑器保护状态。
    if app
        .state::<crate::files::EditorGuard>()
        .0
        .load(Ordering::SeqCst)
    {
        return Err("请先保存或放弃文件修改，再安装更新。".into());
    }
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}
