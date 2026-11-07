pub use uterm_core::ssh::tunnels::{Forward, SshTunnels, Status};
use utermd_local::ssh::SshTarget;
#[tauri::command]
pub async fn ssh_tunnel_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshTunnels>,
    connection: SshTarget,
    rule: Forward,
) -> Result<Status, String> {
    let target = connection.clone();
    state.start(
        async move { crate::ssh_auth::prepare(&app, &target).await },
        connection,
        rule,
    )
}
#[tauri::command]
pub async fn ssh_tunnel_list(state: tauri::State<'_, SshTunnels>) -> Result<Vec<Status>, String> {
    state.list().await
}
#[tauri::command]
pub async fn ssh_tunnel_stop(
    state: tauri::State<'_, SshTunnels>,
    connection_id: String,
    id: String,
) -> Result<(), String> {
    state.stop_one(connection_id, id).await
}
