use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[schemars(rename = "GitWorktree")]
pub struct Worktree {
    path: String,
    branch: String,
    missing: bool,
}
use crate::git::run as git;
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
pub fn project_worktrees(directory: String) -> Result<Vec<Worktree>, String> {
    discover(&directory)
}
pub fn create_worktree(
    directory: String,
    reference: Option<String>,
    branch: Option<String>,
    path: Option<String>,
    oid: Option<String>,
) -> Result<Vec<Worktree>, String> {
    {
        let _guard = crate::git::BRANCH_OPERATION
            .lock()
            .map_err(|error| error.to_string())?;
        match (reference, branch, path) {
            (None, None, None) => create_worktree_in(&directory, &worktree_root()),
            (Some(reference), Some(branch), Some(path)) => {
                create_worktree_at(&directory, &reference, &branch, &path, oid.as_deref())
            }
            _ => Err("请填写 Worktree 基点、分支和绝对路径。".into()),
        }
    }
}
pub fn delete_worktree(directory: String, path: String) -> Result<Vec<Worktree>, String> {
    {
        let _guard = crate::git::BRANCH_OPERATION
            .lock()
            .map_err(|error| error.to_string())?;
        delete_worktree_at(&directory, &path)
    }
}

fn worktree_root() -> std::path::PathBuf {
    std::env::temp_dir().join("uterm-worktrees")
}
#[derive(Serialize, schemars::JsonSchema)]
#[schemars(rename = "GitWorktreeSuggestion")]
pub struct WorktreeSuggestion {
    branch: String,
    path: String,
}
pub fn worktree_suggestion(
    directory: String,
    reference: String,
) -> Result<WorktreeSuggestion, String> {
    {
        crate::git::revision(&directory, &reference)?;
        let source = reference
            .strip_prefix("refs/heads/")
            .or_else(|| reference.strip_prefix("refs/tags/"))
            .or_else(|| reference.strip_prefix("refs/remotes/"))
            .unwrap_or("HEAD");
        let root = worktree_root();
        for number in 1.. {
            let branch = format!("{source}-worktree-{number}");
            let path = root.join(format!("{}-worktree-{number}", directory_name(source)));
            if !path.exists()
                && git(
                    &directory,
                    &[
                        "show-ref",
                        "--verify",
                        "--quiet",
                        &format!("refs/heads/{branch}"),
                    ],
                )
                .is_err()
            {
                return Ok(WorktreeSuggestion {
                    branch,
                    path: path.to_string_lossy().into(),
                });
            }
        }
        unreachable!()
    }
}
fn create_worktree_at(
    directory: &str,
    reference: &str,
    branch: &str,
    path: &str,
    expected: Option<&str>,
) -> Result<Vec<Worktree>, String> {
    let oid = crate::git::validate_reference(directory, reference, expected)?;
    if branch.is_empty() || branch.starts_with('-') || branch == "HEAD" {
        return Err("分支名无效。".into());
    }
    git(
        directory,
        &["check-ref-format", &format!("refs/heads/{branch}")],
    )?;
    let target = Path::new(path);
    if !target.is_absolute() || target.exists() {
        return Err("Worktree 路径必须是尚不存在的绝对路径。".into());
    }
    crate::git::run(
        directory,
        &[
            "worktree",
            "add",
            "--no-track",
            "-b",
            branch,
            "--",
            path,
            &oid,
        ],
    )?;
    discover(directory)
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
    fn selected_reference_worktree_uses_new_branch_and_checks_base_and_destination() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_str().unwrap();
        git(directory, &["init", "-b", "main"]).unwrap();
        git(
            directory,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--no-gpg-sign",
                "--allow-empty",
                "-m",
                "base",
            ],
        )
        .unwrap();
        git(directory, &["tag", "base/tag"]).unwrap();
        let oid = crate::git::revision(directory, "HEAD").unwrap();
        let path = root.path().join("new tree 中文");
        let items = create_worktree_at(
            directory,
            "refs/tags/base/tag",
            "feature/tree",
            path.to_str().unwrap(),
            Some(&oid),
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].branch, "feature/tree");
        assert_eq!(current_branch(directory).unwrap(), "main");
        assert_eq!(
            crate::git::revision(path.to_str().unwrap(), "HEAD").unwrap(),
            oid
        );
        assert!(create_worktree_at(
            directory,
            "refs/tags/base/tag",
            "other",
            path.to_str().unwrap(),
            Some(&oid)
        )
        .is_err());
        assert!(create_worktree_at(directory, "HEAD", "other", "relative", Some(&oid)).is_err());
        let other = root.path().join("stale");
        assert!(create_worktree_at(
            directory,
            "HEAD",
            "other",
            other.to_str().unwrap(),
            Some("stale")
        )
        .is_err());
        assert!(!other.exists());
    }

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
