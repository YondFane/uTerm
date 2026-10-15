use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct Worktree {
    path: String,
    branch: String,
    missing: bool,
}
fn git(directory: &str, arguments: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(directory)
        .args(arguments);
    for variable in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_CONFIG_COUNT",
    ] {
        command.env_remove(variable);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|error| format!("无法运行 Git：{error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().into());
    }
    Ok(output.stdout)
}
fn discover(directory: &str) -> Result<Vec<Worktree>, String> {
    let output = git(directory, &["worktree", "list", "--porcelain", "-z"])?;
    let root = Path::new(directory)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    parse_worktrees(&output).map(|worktrees| {
        worktrees
            .into_iter()
            .filter(|worktree| {
                Path::new(&worktree.path).canonicalize().ok().as_ref() != Some(&root)
            })
            .collect()
    })
}
fn parse_worktrees(bytes: &[u8]) -> Result<Vec<Worktree>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Worktree 路径包含无法显示的字符。")?;
    let mut result = Vec::new();
    let mut current: Option<Worktree> = None;
    for field in text.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            if let Some(worktree) = current.take() {
                result.push(worktree);
            }
            current = Some(Worktree {
                path: path.into(),
                branch: String::new(),
                missing: !Path::new(path).is_dir(),
            });
        } else if let Some(branch) = field.strip_prefix("branch refs/heads/") {
            if let Some(worktree) = &mut current {
                worktree.branch = branch.into();
            }
        }
    }
    if let Some(worktree) = current {
        result.push(worktree);
    }
    Ok(result)
}
#[tauri::command]
pub async fn project_worktrees(directory: String) -> Result<Vec<Worktree>, String> {
    tauri::async_runtime::spawn_blocking(move || discover(&directory))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn create_worktree(directory: String) -> Result<Vec<Worktree>, String> {
    tauri::async_runtime::spawn_blocking(move || create_worktree_in(&directory, &worktree_root()))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn delete_worktree(directory: String, path: String) -> Result<Vec<Worktree>, String> {
    tauri::async_runtime::spawn_blocking(move || delete_worktree_at(&directory, &path))
        .await
        .map_err(|error| error.to_string())?
}

fn worktree_root() -> std::path::PathBuf {
    std::env::temp_dir().join("uterm-worktrees")
}

fn current_branch(directory: &str) -> Result<String, String> {
    let branch = String::from_utf8(git(directory, &["branch", "--show-current"])?)
        .map_err(|error| format!("Git 返回了无法显示的当前分支名：{error}"))?;
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("当前检出为 detached HEAD，无法从当前分支创建 Worktree。".into());
    }
    Ok(branch.into())
}

fn directory_name(branch: &str) -> String {
    let name: String = branch
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let name = name.trim_matches('-');
    if name.is_empty() {
        "worktree".into()
    } else {
        name.into()
    }
}

fn next_worktree(directory: &str, root: &Path) -> Result<(String, std::path::PathBuf), String> {
    let source = current_branch(directory)?;
    std::fs::create_dir_all(root)
        .map_err(|error| format!("无法创建临时 Worktree 目录：{error}"))?;
    let registered = discover(directory)?;
    for number in 1.. {
        let branch = format!("{source}-worktree-{number}");
        let path = root.join(format!("{}-worktree-{number}", directory_name(&source)));
        if !path.exists()
            && !registered
                .iter()
                .any(|worktree| Path::new(&worktree.path) == path)
            && git(
                directory,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{branch}"),
                ],
            )
            .is_err()
        {
            return Ok((branch, path));
        }
    }
    unreachable!("an unbounded worktree suffix search always finds a free name")
}

fn create_worktree_in(directory: &str, root: &Path) -> Result<Vec<Worktree>, String> {
    let (branch, path) = next_worktree(directory, root)?;
    let path = path
        .to_str()
        .ok_or_else(|| "临时 Worktree 路径包含无法传给 Git 的字符。".to_string())?;
    let source = current_branch(directory)?;
    git(
        directory,
        &["worktree", "add", "-b", &branch, "--", path, &source],
    )?;
    discover(directory)
}

fn delete_worktree_at(directory: &str, path: &str) -> Result<Vec<Worktree>, String> {
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err("Worktree 路径必须是绝对路径。".into());
    }
    let target = target
        .canonicalize()
        .map_err(|error| format!("无法读取要删除的 Worktree：{error}"))?;
    let worktree = discover(directory)?
        .into_iter()
        .find(|worktree| Path::new(&worktree.path).canonicalize().ok().as_ref() == Some(&target))
        .ok_or_else(|| "该路径不是此项目已登记的 Worktree。".to_string())?;
    git(directory, &["worktree", "remove", "--", &worktree.path])?;
    if Path::new(&worktree.path).exists() {
        return Err("Git 未能移除 Worktree 目录。".into());
    }
    discover(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_paths_with_spaces_newlines_and_detached_branches() {
        let items = parse_worktrees(b"worktree /tmp/a b\nrepo\0HEAD abc\0branch refs/heads/feature/foo\0\0worktree C:/tree\0HEAD def\0detached\0\0").expect("parse");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].path, "/tmp/a b\nrepo");
        assert_eq!(items[0].branch, "feature/foo");
        assert_eq!(items[1].branch, "");
    }
    #[test]
    fn creates_and_removes_temporary_worktrees_without_changing_the_original_checkout() {
        let root = std::env::temp_dir().join(format!(
            "uterm-worktree-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("temporary directory");
        let directory = root.to_str().expect("path");
        git(directory, &["init", "-b", "main"]).expect("init");
        git(
            directory,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=",
                "commit",
                "--allow-empty",
                "-m",
                "test: initialize fixture",
            ],
        )
        .expect("seed commit");
        git(directory, &["checkout", "-b", "feature/sidebar"]).expect("source branch");
        let worktree_root = root.join("worktrees");
        let items = create_worktree_in(directory, &worktree_root).expect("create Worktree");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].branch, "feature/sidebar-worktree-1");
        assert!(!items[0].missing);
        let first = worktree_root.join("feature-sidebar-worktree-1");
        assert!(first.is_dir());
        assert_eq!(
            git(directory, &["branch", "--show-current"]).expect("branch"),
            b"feature/sidebar\n"
        );
        let items = create_worktree_in(directory, &worktree_root).expect("create another Worktree");
        assert_eq!(items.len(), 2);
        assert!(items
            .iter()
            .any(|item| item.branch == "feature/sidebar-worktree-2"));
        let second = worktree_root.join("feature-sidebar-worktree-2");
        let items =
            delete_worktree_at(directory, first.to_str().expect("path")).expect("delete Worktree");
        assert!(!first.exists());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].branch, "feature/sidebar-worktree-2");
        std::fs::write(second.join("draft.txt"), "uncommitted").expect("dirty file");
        assert!(delete_worktree_at(directory, second.to_str().expect("path")).is_err());
        assert!(second.is_dir());
        std::fs::remove_dir_all(&root).expect("remove fixture");
    }
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
        if target == "github" {
            let remotes = crate::git::run(&directory, &["remote", "-v"])?;
            let repository = String::from_utf8_lossy(&remotes)
                .lines()
                .filter_map(|line| {
                    let mut parts = line.split_whitespace();
                    let name = parts.next()?;
                    let slug = crate::github::remote_slug(parts.next()?)?;
                    Some((name == "origin", slug))
                })
                .max_by_key(|(origin, _)| *origin)
                .map(|(_, slug)| slug)
                .ok_or("此工作目录没有 GitHub 远程仓库。")?;
            return app
                .opener()
                .open_url(format!("https://github.com/{repository}"), None::<&str>)
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
