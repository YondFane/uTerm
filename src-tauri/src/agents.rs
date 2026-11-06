use std::path::PathBuf;
use tauri::Manager;
pub use uterm_core::agents::Usage;
use utermd_local::agents::AgentDefinition;
fn host(app: &tauri::AppHandle) -> Result<uterm_core::agents::Host, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let reporter: PathBuf = std::env::current_exe().map_err(|error| error.to_string())?;
    let context = uterm_core::agents::Host::from_environment(data, reporter)?;
    #[cfg(feature = "qa")]
    if app.config().identifier == crate::qa::IDENTIFIER {
        let mut context = context;
        context.home = crate::qa::root()?.join("agent-home");
        context.agent_homes.clear();
        return Ok(context);
    }
    Ok(context)
}
#[tauri::command]
pub fn agent_definitions(app: tauri::AppHandle) -> Result<Vec<AgentDefinition>, String> {
    uterm_core::agents::agent_definitions(host(&app)?)
}
#[tauri::command]
pub async fn save_agents(
    app: tauri::AppHandle,
    definitions: Vec<AgentDefinition>,
) -> Result<(), String> {
    let host = host(&app)?;
    tauri::async_runtime::spawn_blocking(move || uterm_core::agents::save_agents(host, definitions))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn agent_hooks(
    app: tauri::AppHandle,
    agent: String,
    enabled: bool,
) -> Result<String, String> {
    let host = host(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::agents::agent_hooks(host, agent, enabled)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn agent_usage(
    app: tauri::AppHandle,
    agent: String,
    remote: Option<bool>,
    allow_keychain: Option<bool>,
) -> Result<Usage, String> {
    let host = host(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::agents::agent_usage(host, agent, remote, allow_keychain)
    })
    .await
    .map_err(|error| error.to_string())?
}
