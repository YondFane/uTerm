use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;
pub use utermd_local::control::{cli, Control, Request};

#[tauri::command]
pub async fn control_wait(state: tauri::State<'_, Arc<Control>>) -> Result<bool, String> {
    state.inner().clone().wait().await
}
#[tauri::command]
pub fn control_status(state: tauri::State<'_, Arc<Control>>) -> Value {
    state.status()
}
#[tauri::command]
pub fn control_configure(
    state: tauri::State<'_, Arc<Control>>,
    enabled: bool,
) -> Result<(), String> {
    state.configure(enabled)
}
#[tauri::command]
pub fn control_poll(state: tauri::State<'_, Arc<Control>>) -> Result<Option<Request>, String> {
    state.poll()
}
#[tauri::command]
pub fn control_reply(
    state: tauri::State<'_, Arc<Control>>,
    id: String,
    result: Value,
) -> Result<(), String> {
    state.reply(&id, result)
}
#[tauri::command]
pub fn control_focus(app: tauri::AppHandle) -> Result<(), String> {
    crate::show_main_window(&app)
}
#[tauri::command]
pub fn control_install(app: tauri::AppHandle) -> Result<String, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let bin = directory.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let path = bin.join(if cfg!(windows) { "uterm.cmd" } else { "uterm" });
    let exe = executable.to_str().ok_or("程序路径无法转换为文本。")?;
    let root = directory.to_str().ok_or("设置目录无法转换为文本。")?;
    let script = if cfg!(windows) {
        format!("@echo off\r\nstart /wait \"\" \"{}\" --control --data-dir \"{}\" %*\r\nexit /b %errorlevel%\r\n", exe.replace('%', "%%"), root.replace('%', "%%"))
    } else {
        let quote = |text: &str| format!("'{}'", text.replace('\'', "'\\''"));
        format!(
            "#!/bin/sh\nexec {} --control --data-dir {} \"$@\"\n",
            quote(exe),
            quote(root)
        )
    };
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into())
}
