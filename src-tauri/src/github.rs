use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
fn slug(value: &str) -> bool {
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && ![".", ".."].contains(part)
                && !part.starts_with('-')
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
}
pub(crate) fn remote_slug(value: &str) -> Option<String> {
    let value = value.trim().strip_suffix(".git").unwrap_or(value.trim());
    let value = value
        .strip_prefix("https://github.com/")
        .or_else(|| value.strip_prefix("git@github.com:"))
        .or_else(|| value.strip_prefix("ssh://git@github.com/"))?;
    slug(value).then(|| value.to_string())
}
fn gh(directory: &str, arguments: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("gh");
    command
        .current_dir(directory)
        .args(arguments)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "cat")
        .env("GH_HOST", "github.com")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env_remove("GH_REPO");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = crate::git::run_command(command)?;
    if output.len() > 2 * 1024 * 1024 {
        return Err("GitHub 响应超过 2 MB，请在浏览器中查看。".into());
    }
    Ok(output)
}
fn gh_json(directory: &str, arguments: &[&str]) -> Result<Value, String> {
    serde_json::from_slice(&gh(directory, arguments)?).map_err(|_| "无法解析 GitHub 响应。".into())
}
fn repositories(directory: &str) -> Result<Vec<String>, String> {
    let remotes = crate::git::run(directory, &["remote", "-v"])?;
    let mut names: Vec<String> = String::from_utf8_lossy(&remotes)
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1).and_then(remote_slug))
        .collect();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return Err("此项目没有 github.com 远程仓库。".into());
    }
    // Fork parents are legitimate review targets without changing the checkout's remotes.
    let original = names.clone();
    for repo in original {
        let value = gh_json(directory, &["repo", "view", &repo, "--json", "parent"])?;
        if let (Some(owner), Some(name)) = (
            value["parent"]["owner"]["login"].as_str(),
            value["parent"]["name"].as_str(),
        ) {
            let parent = format!("{owner}/{name}");
            if slug(&parent) {
                names.push(parent);
            }
        }
    }
    names.sort();
    names.dedup();
    Ok(names)
}
#[tauri::command]
pub async fn github_repositories(directory: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || repositories(&directory))
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
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !slug(&repository) || !["issue", "pr"].contains(&kind.as_str()) { return Err("仓库或条目类型无效。".into()); }
        if let Some(number) = number {
            if number == 0 { return Err("编号无效。".into()); }
            if diff.unwrap_or(false) && kind == "pr" { return Ok(json!({"text":String::from_utf8_lossy(&gh(&directory, &["pr", "diff", &number.to_string(), "--repo", &repository, "--color", "never"])?)})); }
            let fields = if kind == "pr" { "number,title,body,url,state,author,labels,comments,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup,files" } else { "number,title,body,url,state,author,labels,comments,assignees" };
            return gh_json(&directory, &[&kind, "view", &number.to_string(), "--repo", &repository, "--json", fields]);
        }
        let state = state.unwrap_or_else(|| "open".into()); if !["open", "closed", "all"].contains(&state.as_str()) { return Err("状态无效。".into()); }
        let query = query.unwrap_or_default(); if query.len() > 500 { return Err("搜索内容过长。".into()); }
        gh_json(&directory, &[&kind, "list", "--repo", &repository, "--state", &state, "--limit", &limit.unwrap_or(50).clamp(1, 500).to_string(), "--search", &query, "--json", "number,title,url,state,author,labels,updatedAt"])
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn github_prepare_pr(directory: String, repository: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !slug(&repository) { return Err("仓库无效。".into()); }
        let repo = gh_json(&directory, &["repo", "view", &repository, "--json", "defaultBranchRef"])?;
        let branch = String::from_utf8_lossy(&crate::git::run(&directory, &["symbolic-ref", "--quiet", "--short", "HEAD"])?).trim().to_owned();
        let title = String::from_utf8_lossy(&crate::git::run(&directory, &["log", "-1", "--format=%s"])?).trim().to_owned();
        let remotes = crate::git::run(&directory, &["remote", "get-url", "origin"])?;
        let origin = remote_slug(&String::from_utf8_lossy(&remotes)).ok_or("origin 不是 GitHub 仓库。")?;
        let head = if origin == repository { branch.clone() } else { format!("{}:{branch}", origin.split('/').next().ok_or("远程仓库无效。")?) };
        Ok(json!({"base":repo["defaultBranchRef"]["name"],"head":head,"title":title,"branch":branch}))
    }).await.map_err(|e| e.to_string())?
}
fn pr_payload(
    repository: &str,
    title: &str,
    body: &str,
    base: &str,
    head: &str,
    draft: bool,
) -> Result<Value, String> {
    if !slug(repository)
        || title.trim().is_empty()
        || title.len() > 256
        || body.len() > 60000
        || base.is_empty()
        || head.is_empty()
        || base.len() > 300
        || head.len() > 400
    {
        return Err("请检查 PR 的仓库、标题和分支。".into());
    }
    Ok(json!({"title":title,"body":body,"base":base,"head":head,"draft":draft}))
}
#[tauri::command]
pub async fn github_create_pr(
    directory: String,
    repository: String,
    title: String,
    body: String,
    base: String,
    head: String,
    draft: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let payload = pr_payload(&repository, &title, &body, &base, &head, draft)?;
        let mut input = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        input
            .write_all(
                serde_json::to_string(&payload)
                    .map_err(|e| e.to_string())?
                    .as_bytes(),
            )
            .map_err(|e| e.to_string())?;
        // The API only creates the PR: unlike `gh pr create`, it cannot push or fork implicitly.
        gh_json(
            &directory,
            &[
                "api",
                "--hostname",
                "github.com",
                "--method",
                "POST",
                &format!("repos/{repository}/pulls"),
                "--input",
                input.path().to_str().ok_or("临时路径无效。")?,
            ],
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pr_payload_preserves_text_without_shell_interpolation() {
        let value = pr_payload(
            "owner/repo",
            "Keep `literal` title",
            "Line one\n$(literal)",
            "main",
            "fork:feature",
            true,
        )
        .unwrap();
        assert_eq!(value["body"], "Line one\n$(literal)");
        assert_eq!(value["draft"], true);
        assert_eq!(value["head"], "fork:feature");
        assert!(pr_payload("../repo", "title", "", "main", "branch", false).is_err());
        assert!(pr_payload("owner/repo", " ", "", "main", "branch", false).is_err());
    }
    #[test]
    fn remotes_do_not_accept_other_hosts_or_arguments() {
        assert_eq!(
            remote_slug("git@github.com:owner/repo.git"),
            Some("owner/repo".into())
        );
        assert_eq!(
            remote_slug("https://github.com/owner/repo"),
            Some("owner/repo".into())
        );
        for value in [
            "https://github.com.evil/owner/repo",
            "-R other/repo",
            "https://github.com/owner/repo/extra",
            "https://user:token@github.com/owner/repo",
        ] {
            assert!(remote_slug(value).is_none());
        }
    }
}
