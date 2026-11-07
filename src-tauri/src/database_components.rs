pub(crate) use uterm_core::archives::extract_bounded;
pub(crate) use uterm_core::database_components::{download_file, valid_file, InstallPackage};
pub use uterm_core::database_components::{Artifact, ComponentStatus, Components};

#[tauri::command]
pub async fn database_components(
    app: tauri::AppHandle,
    action: String,
    id: Option<String>,
) -> Result<ComponentStatus, String> {
    uterm_core::database_components::database_components(crate::database::host(&app)?, action, id)
        .await
}
