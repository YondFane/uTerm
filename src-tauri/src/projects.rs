use serde::Serialize;
use std::path::Path;
use std::process::Command;
pub use uterm_core::worktrees::{Worktree, WorktreeSuggestion};

#[tauri::command]
pub async fn project_worktrees(directory: String) -> Result<Vec<Worktree>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::worktrees::project_worktrees(directory)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn create_worktree(
    directory: String,
    reference: Option<String>,
    branch: Option<String>,
    path: Option<String>,
    oid: Option<String>,
) -> Result<Vec<Worktree>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::worktrees::create_worktree(directory, reference, branch, path, oid)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn delete_worktree(directory: String, path: String) -> Result<Vec<Worktree>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::worktrees::delete_worktree(directory, path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn worktree_suggestion(
    directory: String,
    reference: String,
) -> Result<WorktreeSuggestion, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uterm_core::worktrees::worktree_suggestion(directory, reference)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
pub struct DirectoryTool {
    id: String,
    name: String,
}
fn editor_path(id: &str) -> Option<std::path::PathBuf> {
    let (app, executable) = match id {
        "cursor" => ("Cursor", "cursor"),
        "vscode" => ("Visual Studio Code", "code"),
        "xcode" => ("Xcode", "xed"),
        "idea" => ("IntelliJ IDEA", "idea"),
        _ => return None,
    };
    if cfg!(target_os = "macos") {
        let mut roots = vec![std::path::PathBuf::from("/Applications")];
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(std::path::PathBuf::from(home).join("Applications"));
        }
        for root in roots {
            for name in [format!("{app}.app"), format!("{app} CE.app")] {
                let path = root.join(name);
                if path.is_dir() {
                    return Some(path);
                }
            }
        }
        return None;
    }
    if id == "xcode" {
        return None;
    }
    let mut candidates = Vec::new();
    if cfg!(windows) {
        for variable in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(variable) {
                let root = std::path::PathBuf::from(root);
                let relative = match id {
                    "cursor" => "Programs/cursor/Cursor.exe",
                    "vscode" => "Programs/Microsoft VS Code/Code.exe",
                    _ => "JetBrains/IntelliJ IDEA/bin/idea64.exe",
                };
                candidates.push(root.join(relative));
                if id == "idea" {
                    if let Ok(entries) = std::fs::read_dir(root.join("JetBrains")) {
                        for entry in entries.take(100).flatten() {
                            if entry
                                .file_name()
                                .to_string_lossy()
                                .starts_with("IntelliJ IDEA")
                            {
                                candidates.push(entry.path().join("bin/idea64.exe"));
                            }
                        }
                    }
                }

                if id == "vscode" {
                    candidates.push(root.join("Microsoft VS Code/Code.exe"));
                }
                if id == "cursor" {
                    candidates.push(root.join("Cursor/Cursor.exe"));
                }
            }
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for root in std::env::split_paths(&paths) {
            candidates.push(root.join(if cfg!(windows) {
                format!("{executable}.exe")
            } else {
                executable.into()
            }));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}
#[tauri::command]
pub async fn directory_tools() -> Result<Vec<DirectoryTool>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        [
            ("cursor", "Cursor"),
            ("vscode", "VS Code"),
            ("xcode", "Xcode"),
            ("idea", "IntelliJ IDEA"),
        ]
        .into_iter()
        .filter(|(id, _)| editor_path(id).is_some())
        .map(|(id, name)| DirectoryTool {
            id: id.into(),
            name: name.into(),
        })
        .collect()
    })
    .await
    .map_err(|error| error.to_string())
}

fn gitlab_remote_url(value: &str) -> Option<String> {
    let value = value.trim();
    let remote = if value.contains("://") {
        tauri::Url::parse(value).ok()?
    } else {
        let (host, path) = value.split_once(':')?;
        tauri::Url::parse(&format!("ssh://{host}/{path}")).ok()?
    };
    let host = remote.host_str()?.to_ascii_lowercase();
    if !host.contains("gitlab") || remote.query().is_some() || remote.fragment().is_some() {
        return None;
    }
    let (scheme, port) = match remote.scheme() {
        "http" | "https" => (remote.scheme(), remote.port()),
        "ssh" => ("https", None),
        _ => return None,
    };
    let repository = remote.path().trim_matches('/');
    let repository = repository.strip_suffix(".git").unwrap_or(repository);
    let parts: Vec<_> = repository.split('/').collect();
    (parts.len() >= 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && ![".", ".."].contains(part)
                && !part.starts_with('-')
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        }))
    .then(|| {
        let port = port.map(|port| format!(":{port}")).unwrap_or_default();
        format!("{scheme}://{host}{port}/{repository}")
    })
}

fn directory_remote_url(remotes: &str, target: &str) -> Option<String> {
    remotes
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let name = parts.next()?;
            let remote = parts.next()?;
            let url = match target {
                "github" => crate::github::remote_slug(remote)
                    .map(|repository| format!("https://github.com/{repository}")),
                "gitlab" => gitlab_remote_url(remote),
                _ => None,
            }?;
            Some((name == "origin", url))
        })
        .max_by_key(|(origin, _)| *origin)
        .map(|(_, url)| url)
}

#[tauri::command]
pub async fn directory_open(
    app: tauri::AppHandle,
    directory: String,
    target: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_opener::OpenerExt;
        let path = Path::new(&directory)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !path.is_dir() {
            return Err("工作目录不存在。".into());
        }
        if target == "reveal" {
            return app
                .opener()
                .open_path(path.to_string_lossy(), None::<&str>)
                .map_err(|error| error.to_string());
        }
        if target == "github" || target == "gitlab" {
            let remotes = crate::git::run(&directory, &["remote", "-v"])?;
            let url = directory_remote_url(&String::from_utf8_lossy(&remotes), &target).ok_or(
                if target == "github" {
                    "此工作目录没有 GitHub 远程仓库。"
                } else {
                    "此工作目录没有 GitLab 远程仓库。"
                },
            )?;
            return app
                .opener()
                .open_url(url, None::<&str>)
                .map_err(|error| error.to_string());
        }
        let editor = editor_path(&target).ok_or("编辑器未安装或无法找到。")?;
        let mut command = if cfg!(target_os = "macos") {
            let mut command = Command::new("/usr/bin/open");
            command.arg("-a").arg(editor).arg(&path);
            command
        } else {
            let mut command = Command::new(editor);
            command.arg(&path);
            command
        };
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if cfg!(target_os = "macos") {
            let status = command.status().map_err(|error| error.to_string())?;
            return if status.success() {
                Ok(())
            } else {
                Err("无法打开编辑器，请检查应用是否可用。".into())
            };
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法打开编辑器：{error}"))?;
        // GUI editors can remain running until the user closes them.
        std::thread::spawn(move || {
            if let Err(error) = child.wait() {
                eprintln!("Editor process: {error}");
            }
        });
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gitlab_remotes_support_web_ssh_and_nested_groups() {
        for remote in [
            "https://gitlab.com/team/subgroup/repo.git",
            "git@gitlab.com:team/subgroup/repo.git",
            "ssh://git@gitlab.com/team/subgroup/repo.git",
        ] {
            assert_eq!(
                gitlab_remote_url(remote).as_deref(),
                Some("https://gitlab.com/team/subgroup/repo")
            );
        }
        for (remote, expected) in [
            (
                "https://user:token@gitlab.example.com:8443/team/repo.git/",
                "https://gitlab.example.com:8443/team/repo",
            ),
            (
                "http://code-gitlab.example.com/team/repo",
                "http://code-gitlab.example.com/team/repo",
            ),
            (
                "ssh://git@GITLAB.example.com:2222/team/repo.git",
                "https://gitlab.example.com/team/repo",
            ),
            (
                "git@company-gitlab.example.com:team/repo.git",
                "https://company-gitlab.example.com/team/repo",
            ),
        ] {
            assert_eq!(gitlab_remote_url(remote).as_deref(), Some(expected));
        }
    }

    #[test]
    fn gitlab_remotes_require_a_matching_host_and_repository_path() {
        for remote in [
            "https://github.com/team/gitlab",
            "https://gitlab.com@github.com/team/repo",
            "https://example.com/gitlab/team/repo",
            "file:///tmp/gitlab/team/repo",
            "/tmp/gitlab/team/repo",
            "https://gitlab.com/team",
            "https://gitlab.com/team//repo",
            "https://gitlab.com/team/-repo",
            "https://gitlab.com/team/repo?token=secret",
            "https://gitlab.com/team/repo#fragment",
            "https://gitlab.com/team/repo with spaces",
        ] {
            assert!(gitlab_remote_url(remote).is_none(), "{remote}");
        }
    }

    #[test]
    fn directory_links_prefer_origin_for_the_requested_provider() {
        let remotes = "upstream git@gitlab.com:upstream/repo.git (fetch)\n\
            origin https://gitlab.example.com/team/repo.git (fetch)\n\
            mirror git@gitlab.com:mirror/repo.git (push)\n\
            github git@github.com:team/repo.git (fetch)\n";
        assert_eq!(
            directory_remote_url(remotes, "gitlab").as_deref(),
            Some("https://gitlab.example.com/team/repo")
        );
        assert_eq!(
            directory_remote_url(remotes, "github").as_deref(),
            Some("https://github.com/team/repo")
        );
        let fallback = "origin git@github.com:team/repo.git (fetch)\n\
            upstream git@gitlab.com:team/repo.git (fetch)";
        assert_eq!(
            directory_remote_url(fallback, "gitlab").as_deref(),
            Some("https://gitlab.com/team/repo")
        );
        assert!(directory_remote_url("origin /tmp/repo (fetch)", "gitlab").is_none());
    }
}
