pub(crate) use uterm_core::git::{run, run_command};
pub use uterm_core::git::{
    Branches, Change, Commit, Diff, FileStatus, ReferenceAction, References, RemoteBranches,
    Snapshot,
};

#[tauri::command]
pub async fn git_branch(directory: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || uterm_core::git::git_branch(directory))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_branches(directory: String) -> Result<Branches, String> {
    tauri::async_runtime::spawn_blocking(move || uterm_core::git::git_branches(directory))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_switch_branch(
    directory: String,
    branch: String,
    expected: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::git::git_switch_branch(directory, branch, expected)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_rollback_file(
    directory: String,
    expected: Change,
    head: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::git::git_rollback_file(directory, expected, head)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_remote_branches(directory: String) -> Result<RemoteBranches, String> {
    tauri::async_runtime::spawn_blocking(move || uterm_core::git::git_remote_branches(directory))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_switch_remote_branch(
    directory: String,
    remote: String,
    branch: String,
    expected: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::git::git_switch_remote_branch(directory, remote, branch, expected)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_branch_action(
    directory: String,
    action: String,
    expected: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::git::git_branch_action(directory, action, expected)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_file_status(directory: String) -> Result<Option<FileStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || uterm_core::git::git_file_status(directory))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_snapshot(directory: String) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || uterm_core::git::git_snapshot(directory))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_diff(
    directory: String,
    path: String,
    mode: String,
    reference: Option<String>,
) -> Result<Diff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::git::git_diff(directory, path, mode, reference)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_history(
    directory: String,
    skip: u32,
    reference: Option<String>,
) -> Result<Vec<Commit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::git::git_history(directory, skip, reference)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_files(
    directory: String,
    reference: String,
    compare: bool,
) -> Result<Vec<Change>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::git::git_files(directory, reference, compare)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_references(directory: String) -> Result<References, String> {
    tauri::async_runtime::spawn_blocking(move || uterm_core::git::git_references(directory))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_reference_action(
    directory: String,
    target: ReferenceAction,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::git::git_reference_action(directory, target)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_working_comparison(
    directory: String,
    reference: String,
) -> Result<Vec<Change>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::git::git_working_comparison(directory, reference)
    })
    .await
    .map_err(|error| error.to_string())?
}
