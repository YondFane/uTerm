pub(crate) use uterm_core::github::remote_slug;

#[tauri::command]
pub async fn github_repositories(directory: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || uterm_core::github::repositories(&directory))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn github_read(
    directory: String,
    repository: String,
    kind: String,
    number: Option<u64>,
    query: Option<String>,
    state: Option<String>,
    limit: Option<u16>,
    diff: Option<bool>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::github::read(
            directory, repository, kind, number, query, state, limit, diff,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn github_prepare_pr(
    directory: String,
    repository: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::github::prepare_pr(directory, repository)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn github_create_pr(
    directory: String,
    repository: String,
    title: String,
    body: String,
    base: String,
    head: String,
    draft: bool,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::github::create_pr(directory, repository, title, body, base, head, draft)
    })
    .await
    .map_err(|e| e.to_string())?
}
