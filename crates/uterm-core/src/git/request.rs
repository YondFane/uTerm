use super::*;
use crate::{CoreError, Result};
use serde::de::DeserializeOwned;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Directory {
    directory: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Switch {
    directory: String,
    branch: String,
    expected: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rollback {
    directory: String,
    expected: Change,
    head: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SwitchRemote {
    directory: String,
    remote: String,
    branch: String,
    expected: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BranchAction {
    directory: String,
    action: String,
    expected: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadDiff {
    directory: String,
    path: String,
    mode: String,
    reference: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct History {
    directory: String,
    skip: u32,
    reference: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Files {
    directory: String,
    reference: String,
    compare: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    directory: String,
    target: ReferenceAction,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Comparison {
    directory: String,
    reference: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateWorktree {
    directory: String,
    reference: Option<String>,
    branch: Option<String>,
    path: Option<String>,
    oid: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteWorktree {
    directory: String,
    path: String,
}

fn invoke<T: DeserializeOwned, R: Serialize>(
    params: Value,
    action: impl FnOnce(T) -> std::result::Result<R, String>,
) -> Result<Value> {
    let args = serde_json::from_value(params)
        .map_err(|error| CoreError::new("INVALID_ARGUMENT", error.to_string()))?;
    let result = action(args).map_err(|error| CoreError::new("GIT_ERROR", error))?;
    Ok(serde_json::to_value(result)?)
}

pub fn request(method: &str, params: Value) -> Result<Value> {
    match method {
        "git.branch" => invoke(params, |a: Directory| git_branch(a.directory)),
        "git.branches" => invoke(params, |a: Directory| git_branches(a.directory)),
        "git.switchBranch" => invoke(params, |a: Switch| {
            git_switch_branch(a.directory, a.branch, a.expected)
        }),
        "git.rollbackFile" => invoke(params, |a: Rollback| {
            git_rollback_file(a.directory, a.expected, a.head)
        }),
        "git.remoteBranches" => invoke(params, |a: Directory| git_remote_branches(a.directory)),
        "git.switchRemoteBranch" => invoke(params, |a: SwitchRemote| {
            git_switch_remote_branch(a.directory, a.remote, a.branch, a.expected)
        }),
        "git.branchAction" => invoke(params, |a: BranchAction| {
            git_branch_action(a.directory, a.action, a.expected)
        }),
        "git.fileStatus" => invoke(params, |a: Directory| git_file_status(a.directory)),
        "git.snapshot" => invoke(params, |a: Directory| git_snapshot(a.directory)),
        "git.diff" => invoke(params, |a: ReadDiff| {
            git_diff(a.directory, a.path, a.mode, a.reference)
        }),
        "git.history" => invoke(params, |a: History| {
            git_history(a.directory, a.skip, a.reference)
        }),
        "git.files" => invoke(params, |a: Files| {
            git_files(a.directory, a.reference, a.compare)
        }),
        "git.references" => invoke(params, |a: Directory| git_references(a.directory)),
        "git.referenceAction" => invoke(params, |a: Action| {
            git_reference_action(a.directory, a.target)
        }),
        "git.workingComparison" => invoke(params, |a: Comparison| {
            git_working_comparison(a.directory, a.reference)
        }),
        "git.worktrees.list" => invoke(params, |a: Directory| {
            crate::worktrees::project_worktrees(a.directory)
        }),
        "git.worktrees.create" => invoke(params, |a: CreateWorktree| {
            crate::worktrees::create_worktree(a.directory, a.reference, a.branch, a.path, a.oid)
        }),
        "git.worktrees.delete" => invoke(params, |a: DeleteWorktree| {
            crate::worktrees::delete_worktree(a.directory, a.path)
        }),
        "git.worktrees.suggestion" => invoke(params, |a: Comparison| {
            crate::worktrees::worktree_suggestion(a.directory, a.reference)
        }),
        _ => Err(CoreError::new("UNKNOWN_METHOD", "Unknown Git method")),
    }
}
