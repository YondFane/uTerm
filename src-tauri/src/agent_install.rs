#[tauri::command]
pub async fn install_agent(agent: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || uterm_core::agent_install::install_agent(agent))
        .await
        .map_err(|error| error.to_string())?
}
