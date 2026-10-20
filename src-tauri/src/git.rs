use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
const LIMIT: usize = 2 * 1024 * 1024;

pub(crate) fn run(directory: &str, arguments: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command
        .args([
            "--no-optional-locks",
            "-c",
            "core.pager=cat",
            "-c",
            "color.ui=false",
            "-C",
            directory,
        ])
        .args(arguments)
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for variable in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_CONFIG_COUNT",
        "GIT_EXTERNAL_DIFF",
    ] {
        command.env_remove(variable);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    run_command(command)
}
pub(crate) fn run_command(mut command: Command) -> Result<Vec<u8>, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法运行本地工具：{error}"))?;
    fn capture(mut stream: impl Read) -> std::io::Result<Vec<u8>> {
        let mut output = Vec::new();
        let mut bytes = [0; 8192];
        loop {
            let count = stream.read(&mut bytes)?;
            if count == 0 {
                break;
            }
            let remaining = (LIMIT + 1).saturating_sub(output.len());
            output.extend_from_slice(&bytes[..count.min(remaining)]);
        }
        Ok(output)
    }
    let stdout = child.stdout.take().ok_or("无法读取命令输出。")?;
    let stderr = child.stderr.take().ok_or("无法读取命令错误。")?;
    let output = std::thread::spawn(move || capture(stdout));
    let errors = std::thread::spawn(move || capture(stderr));
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(result
                    .err()
                    .map(|error| error.to_string())
                    .unwrap_or_else(|| "命令执行超时，请重试。".into()));
            }
        }
    };
    let output = output
        .join()
        .map_err(|_| "命令输出线程退出。")?
        .map_err(|error| error.to_string())?;
    let errors = errors
        .join()
        .map_err(|_| "命令错误线程退出。")?
        .map_err(|error| error.to_string())?;
    if !status?.success() {
        return Err(String::from_utf8_lossy(&errors).trim().into());
    }
    Ok(output)
}
fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_string()
}
fn root(directory: &str) -> Result<String, String> {
    Ok(text(run(directory, &["rev-parse", "--show-toplevel"])?))
}
fn revision(directory: &str, value: &str) -> Result<String, String> {
    let commit = text(run(
        directory,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{value}^{{commit}}"),
        ],
    )?);
    if !(40..=64).contains(&commit.len()) || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("提交引用无效。".into());
    }
    Ok(commit)
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Change {
    path: String,
    original: Option<String>,
    index: String,
    working: String,
}
fn status(bytes: &[u8]) -> Result<Vec<Change>, String> {
    let raw = std::str::from_utf8(bytes).map_err(|_| "Git 路径包含无法显示的字符。")?;
    let mut fields = raw.split('\0').filter(|field| !field.is_empty());
    let mut changes = vec![];
    while let Some(field) = fields.next() {
        if field.len() < 4 || !field.is_char_boundary(3) {
            return Err("Git 状态格式无效。".into());
        }
        let index = field[..1].to_string();
        let working = field[1..2].to_string();
        let original =
            if ["R", "C"].contains(&index.as_str()) || ["R", "C"].contains(&working.as_str()) {
                Some(fields.next().ok_or("重命名路径缺失。")?.to_string())
            } else {
                None
            };
        changes.push(Change {
            path: field[3..].into(),
            original,
            index,
            working,
        });
    }
    Ok(changes)
}
#[derive(Serialize)]
pub struct Snapshot {
    root: String,
    branch: String,
    head: Option<String>,
    references: Vec<String>,
    changes: Vec<Change>,
    truncated: bool,
}
fn snapshot(directory: &str) -> Result<Snapshot, String> {
    let root = root(directory)?;
    let branch = text(run(&root, &["branch", "--show-current"])?);
    let raw = run(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    if raw.len() > LIMIT {
        return Err("变更列表过大，请在终端中查看 git status。".into());
    }
    let mut changes = status(&raw)?;
    let truncated = changes.len() > 2000;
    changes.truncate(2000);
    let references = text(run(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
    )?)
    .lines()
    .take(1000)
    .map(String::from)
    .collect();
    Ok(Snapshot {
        head: revision(&root, "HEAD").ok(),
        root,
        branch: if branch.is_empty() {
            "Detached HEAD".into()
        } else {
            branch
        },
        references,
        changes,
        truncated,
    })
}
#[derive(Serialize)]
pub struct Diff {
    text: String,
    truncated: bool,
}
fn diff(directory: &str, path: &str, mode: &str, reference: Option<&str>) -> Result<Diff, String> {
    let root = root(directory)?;
    let bytes = match mode {
        "working" | "staged" => {
            let changes = snapshot(&root)?.changes;
            let change = changes
                .iter()
                .find(|change| change.path == path)
                .ok_or("文件已变化，请刷新列表。")?;
            if change.index == "?" {
                if mode == "staged" {
                    return Err("文件尚未暂存。".into());
                }
                let file = Path::new(&root).join(path);
                if std::fs::symlink_metadata(&file)
                    .map_err(|error| error.to_string())?
                    .file_type()
                    .is_symlink()
                {
                    format!(
                        "符号链接 → {}",
                        std::fs::read_link(file)
                            .map_err(|error| error.to_string())?
                            .display()
                    )
                    .into_bytes()
                } else {
                    let canonical = file.canonicalize().map_err(|error| error.to_string())?;
                    if !canonical.starts_with(
                        PathBuf::from(&root)
                            .canonicalize()
                            .map_err(|error| error.to_string())?,
                    ) {
                        return Err("文件不在仓库中。".into());
                    }
                    let mut bytes = vec![];
                    std::fs::File::open(canonical)
                        .map_err(|error| error.to_string())?
                        .take((LIMIT + 1) as u64)
                        .read_to_end(&mut bytes)
                        .map_err(|error| error.to_string())?;
                    if bytes.contains(&0) {
                        b"Binary file".to_vec()
                    } else {
                        let content = String::from_utf8_lossy(&bytes);
                        let name = serde_json::to_string(&format!("b/{path}"))
                            .map_err(|error| error.to_string())?;
                        let count = content.split_inclusive('\n').count();
                        let mut patch = format!("--- /dev/null\n+++ {name}\n");
                        if count > 0 {
                            patch.push_str(&format!("@@ -0,0 +1,{count} @@\n"));
                            for line in content.split_inclusive('\n') {
                                patch.push('+');
                                patch.push_str(line);
                                if !line.ends_with('\n') {
                                    patch.push_str("\n\\ No newline at end of file\n");
                                }
                            }
                        }
                        patch.into_bytes()
                    }
                }
            } else {
                let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
                if mode == "staged" {
                    args.push("--cached");
                }
                args.extend(["--", path]);
                if let Some(original) = &change.original {
                    args.push(original);
                }
                run(&root, &args)?
            }
        }
        "compare" => {
            let reference = revision(&root, reference.ok_or("请选择对比分支。")?)?;
            run(
                &root,
                &[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    &format!("{reference}...HEAD"),
                    "--",
                    path,
                ],
            )?
        }
        "commit" => {
            let reference = revision(&root, reference.ok_or("请选择提交。")?)?;
            run(
                &root,
                &[
                    "show",
                    "--first-parent",
                    "--format=",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    &reference,
                    "--",
                    path,
                ],
            )?
        }
        _ => return Err("未知的 Diff 类型。".into()),
    };
    let content = String::from_utf8_lossy(&bytes[..bytes.len().min(LIMIT)]);
    let mut lines = content.lines();
    let text = lines.by_ref().take(10000).collect::<Vec<_>>().join("\n");
    let truncated = bytes.len() > LIMIT || lines.next().is_some();
    Ok(Diff { text, truncated })
}
#[derive(Serialize)]
pub struct Commit {
    id: String,
    parents: Vec<String>,
    subject: String,
    message: String,
    author: String,
    timestamp: String,
}
fn current_branch(directory: &str) -> Result<Option<String>, String> {
    let path = Path::new(directory);
    if !path.is_dir() {
        return Err("项目目录不存在。".into());
    }
    if !path.ancestors().any(|parent| parent.join(".git").exists()) {
        return Ok(None);
    }
    match run(directory, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        Ok(value) => Ok(Some(text(value))),
        Err(_) => Ok(Some(format!(
            "HEAD · {}",
            text(run(directory, &["rev-parse", "--short", "HEAD"])?)
        ))),
    }
}
#[tauri::command]
pub async fn git_branch(directory: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || current_branch(&directory))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
pub struct Branches {
    current: Option<String>,
    local: Vec<String>,
    upstream: Option<String>,
}
fn branches(directory: &str) -> Result<Branches, String> {
    let current = current_branch(directory)?;
    let local = if current.is_some() {
        let output = run(
            directory,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "--sort=refname",
                "refs/heads/",
            ],
        )?;
        if output.len() > LIMIT {
            return Err("分支列表过大，请在终端中切换。".into());
        }
        std::str::from_utf8(&output)
            .map_err(|_| "分支名包含无法显示的字符。")?
            .lines()
            .filter_map(|line| line.strip_prefix("refs/heads/").map(String::from))
            .collect()
    } else {
        Vec::new()
    };
    let upstream = current
        .as_ref()
        .filter(|name| local.contains(name))
        .and_then(|name| {
            run(
                directory,
                &[
                    "for-each-ref",
                    "--format=%(upstream:short)",
                    &format!("refs/heads/{name}"),
                ],
            )
            .ok()
            .map(text)
            .filter(|value| !value.is_empty())
        });
    Ok(Branches {
        current,
        local,
        upstream,
    })
}
fn switch_branch(directory: &str, branch: &str, expected: &str) -> Result<(), String> {
    let root = root(directory)?;
    let available = branches(&root)?;
    if available.current.as_deref() != Some(expected) {
        return Err("当前分支已改变，请刷新后重试。".into());
    }
    if branch.starts_with('-') || !available.local.iter().any(|name| name == branch) {
        return Err("请选择现有的本地分支。".into());
    }
    // Let Git reject conflicting changes and branches in other worktrees; never force or stash.
    // 由 Git 拒绝冲突修改及其他 Worktree 占用的分支，不强制切换或自动暂存。
    run(&root, &["switch", "--no-guess", "--", branch])?;
    Ok(())
}
#[tauri::command]
pub async fn git_branches(directory: String) -> Result<Branches, String> {
    tauri::async_runtime::spawn_blocking(move || branches(&directory))
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
        let _guard = BRANCH_OPERATION.lock().map_err(|error| error.to_string())?;
        switch_branch(&directory, &branch, &expected)
    })
    .await
    .map_err(|error| error.to_string())?
}

static BRANCH_OPERATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn rollback_path(directory: &Path, root: &Path, path: &str) -> Result<(), String> {
    let relative = Path::new(path);
    if path.is_empty()
        || relative.components().any(|part| {
            !matches!(part, std::path::Component::Normal(name) if !name.to_string_lossy().eq_ignore_ascii_case(".git"))
        })
        || !root.join(relative).starts_with(directory)
    {
        return Err("回滚文件必须位于所选目录内。".into());
    }
    let mut cursor = root.to_path_buf();
    for part in relative.components() {
        cursor.push(part);
        match std::fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("链接和子模块不能在此回滚，请使用终端。".into());
            }
            Ok(metadata) if cursor == root.join(relative) && !metadata.is_file() => {
                return Err("链接和子模块不能在此回滚，请使用终端。".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn rollback_file(directory: &str, expected: &Change, head: Option<&str>) -> Result<(), String> {
    let selected = Path::new(directory)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let repository = root(directory)?;
    let canonical_root = Path::new(&repository)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let current = snapshot(&repository)?;
    if current.head.as_deref() != head {
        return Err("当前提交已改变，请刷新后重试。".into());
    }
    let change = current
        .changes
        .iter()
        .find(|change| change.path == expected.path)
        .filter(|change| *change == expected)
        .ok_or("文件状态已改变，请刷新后重试。")?;
    let mut paths = vec![change.path.as_str()];
    if change.index == "R" || change.working == "R" {
        let original = change.original.as_deref().ok_or("重命名路径缺失。")?;
        if current.changes.iter().any(|other| other.path == original) {
            return Err("原路径存在其他变更，请先在终端中处理。".into());
        }
        paths.push(original);
    }
    for path in &paths {
        rollback_path(&selected, &canonical_root, path)?;
    }
    let mut indexed = vec!["ls-files", "--stage", "-z", "--"];
    indexed.extend(&paths);
    let indexed = run(&repository, &indexed)?;
    let mut committed = vec![];
    if let Some(head) = head {
        let mut args = vec!["ls-tree", "-z", head, "--"];
        args.extend(&paths);
        committed = run(&repository, &args)?;
    }
    if indexed.len() > LIMIT || committed.len() > LIMIT {
        return Err("文件状态已改变，请刷新后重试。".into());
    }
    for entry in indexed
        .split(|byte| *byte == 0)
        .chain(committed.split(|byte| *byte == 0))
    {
        if entry.starts_with(b"120000 ")
            || entry.starts_with(b"160000 ")
            || entry.starts_with(b"040000 ")
        {
            return Err("链接和子模块不能在此回滚，请使用终端。".into());
        }
    }
    if change.index == "?" {
        // Remove only the confirmed file; never recurse into an untracked directory.
        // 只删除已确认的文件，绝不递归删除未跟踪目录。
        std::fs::remove_file(canonical_root.join(&change.path))
            .map_err(|error| error.to_string())?;
    } else if let Some(head) = head {
        let mut args = vec![
            "restore",
            "--source",
            head,
            "--staged",
            "--worktree",
            "--no-recurse-submodules",
            "--",
        ];
        args.extend(paths);
        run(&repository, &args)?;
    } else {
        let mut args = vec!["rm", "--force", "--"];
        args.extend(paths);
        run(&repository, &args)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_rollback_file(
    directory: String,
    expected: Change,
    head: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = BRANCH_OPERATION.lock().map_err(|error| error.to_string())?;
        rollback_file(&directory, &expected, head.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Serialize)]
pub struct RemoteBranch {
    remote: String,
    branch: String,
}
#[derive(Serialize)]
pub struct RemoteBranches {
    branches: Vec<RemoteBranch>,
    errors: Vec<String>,
}
fn remotes(directory: &str) -> Result<Vec<String>, String> {
    Ok(text(run(directory, &["remote"])?)
        .lines()
        .map(String::from)
        .collect())
}
fn validate_remote(directory: &str, remote: &str) -> Result<(), String> {
    if remote.starts_with('-') || !remotes(directory)?.iter().any(|name| name == remote) {
        return Err("请选择已配置的远程仓库。".into());
    }
    Ok(())
}
fn remote_branches(directory: &str) -> Result<RemoteBranches, String> {
    let directory = root(directory)?;
    let mut result = RemoteBranches {
        branches: vec![],
        errors: vec![],
    };
    for remote in remotes(&directory)? {
        let listed = (|| {
            validate_remote(&directory, &remote)?;
            let output = run(&directory, &["ls-remote", "--heads", "--", &remote])?;
            if output.len() > LIMIT {
                return Err("分支列表过大，请在终端中切换。".into());
            }
            let output = std::str::from_utf8(&output).map_err(|_| "分支名包含无法显示的字符。")?;
            Ok::<_, String>(
                output
                    .lines()
                    .filter_map(|line| {
                        let (_, reference) = line.split_once('\t')?;
                        Some(RemoteBranch {
                            remote: remote.clone(),
                            branch: reference.strip_prefix("refs/heads/")?.into(),
                        })
                    })
                    .collect::<Vec<_>>(),
            )
        })();
        match listed {
            Ok(mut branches) => result.branches.append(&mut branches),
            Err(error) => result.errors.push(format!("{remote}: {error}")),
        }
    }
    result
        .branches
        .sort_by(|a, b| (&a.remote, &a.branch).cmp(&(&b.remote, &b.branch)));
    Ok(result)
}
fn expect_branch(directory: &str, expected: &str) -> Result<(), String> {
    if current_branch(directory)?.as_deref() != Some(expected) {
        return Err("当前分支已改变，请刷新后重试。".into());
    }
    Ok(())
}
fn switch_remote_branch(
    directory: &str,
    remote: &str,
    branch: &str,
    expected: &str,
) -> Result<(), String> {
    let directory = root(directory)?;
    validate_remote(&directory, remote)?;
    expect_branch(&directory, expected)?;
    if branch.starts_with('-') || branch == "HEAD" {
        return Err("远程分支名无效。".into());
    }
    run(
        &directory,
        &["check-ref-format", &format!("refs/heads/{branch}")],
    )?;
    let tracking = format!("refs/remotes/{remote}/{branch}");
    let local_exists = branches(&directory)?
        .local
        .iter()
        .any(|name| name == branch);
    if local_exists {
        let upstream = text(run(
            &directory,
            &[
                "for-each-ref",
                "--format=%(upstream)",
                &format!("refs/heads/{branch}"),
            ],
        )?);
        if upstream != tracking {
            return Err("同名本地分支已存在，但跟踪的远程分支不同。请先在终端中处理。".into());
        }
    }
    run(
        &directory,
        &[
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--",
            remote,
            &format!("+refs/heads/{branch}:{tracking}"),
        ],
    )?;
    expect_branch(&directory, expected)?;
    if local_exists {
        return switch_branch(&directory, branch, expected);
    }
    // Configure tracking explicitly so single-branch clones can also select other remote branches.
    // 显式配置跟踪关系，使单分支克隆也能选择其他远程分支。
    run(
        &directory,
        &[
            "switch",
            "--no-guess",
            "--no-track",
            "-c",
            branch,
            "--",
            &tracking,
        ],
    )?;
    run(
        &directory,
        &["config", &format!("branch.{branch}.remote"), remote],
    )?;
    run(
        &directory,
        &[
            "config",
            &format!("branch.{branch}.merge"),
            &format!("refs/heads/{branch}"),
        ],
    )?;
    if text(run(
        &directory,
        &[
            "for-each-ref",
            "--format=%(upstream)",
            &format!("refs/heads/{branch}"),
        ],
    )?) != tracking
    {
        run(
            &directory,
            &[
                "config",
                "--add",
                &format!("remote.{remote}.fetch"),
                &format!("+refs/heads/{branch}:{tracking}"),
            ],
        )?;
    }
    Ok(())
}
fn branch_action(directory: &str, action: &str, expected: &str) -> Result<(), String> {
    let directory = root(directory)?;
    expect_branch(&directory, expected)?;
    if action == "fetch" {
        for remote in remotes(&directory)? {
            validate_remote(&directory, &remote)?;
            run(
                &directory,
                &[
                    "fetch",
                    "--no-tags",
                    "--no-recurse-submodules",
                    "--prune",
                    "--",
                    &remote,
                    &format!("+refs/heads/*:refs/remotes/{remote}/*"),
                ],
            )?;
        }
        return Ok(());
    }
    if !["push", "pull"].contains(&action) {
        return Err("未知的 Git 操作。".into());
    }
    if !branches(&directory)?
        .local
        .iter()
        .any(|branch| branch == expected)
    {
        return Err("请先切换到已有提交的本地分支。".into());
    }
    let remote = text(
        run(
            &directory,
            &["config", "--get", &format!("branch.{expected}.remote")],
        )
        .map_err(|_| "当前分支没有上游，请先在终端中设置上游分支。")?,
    );
    let merge = text(
        run(
            &directory,
            &["config", "--get", &format!("branch.{expected}.merge")],
        )
        .map_err(|_| "当前分支没有上游，请先在终端中设置上游分支。")?,
    );
    validate_remote(&directory, &remote)?;
    if !merge.starts_with("refs/heads/") {
        return Err("上游分支配置无效。".into());
    }
    run(&directory, &["check-ref-format", &merge])?;
    if action == "push" {
        let commit = revision(&directory, "HEAD")?;
        expect_branch(&directory, expected)?;
        run(
            &directory,
            &[
                "-c",
                &format!("remote.{remote}.mirror=false"),
                "push",
                "--no-force",
                "--no-follow-tags",
                "--recurse-submodules=no",
                "--",
                &remote,
                &format!("{commit}:{merge}"),
            ],
        )?;
    } else {
        // Merge the captured object, not FETCH_HEAD which another Git process can replace.
        // 合并已获取的对象，避免其他 Git 进程覆盖 FETCH_HEAD 后误合并。
        run(
            &directory,
            &[
                "fetch",
                "--no-tags",
                "--no-recurse-submodules",
                "--",
                &remote,
                &merge,
            ],
        )?;
        let commit = revision(&directory, "FETCH_HEAD")?;
        expect_branch(&directory, expected)?;
        run(
            &directory,
            &["merge", "--ff-only", "--no-autostash", &commit],
        )?;
    }
    Ok(())
}
#[tauri::command]
pub async fn git_remote_branches(directory: String) -> Result<RemoteBranches, String> {
    tauri::async_runtime::spawn_blocking(move || remote_branches(&directory))
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
        let _guard = BRANCH_OPERATION.lock().map_err(|error| error.to_string())?;
        switch_remote_branch(&directory, &remote, &branch, &expected)
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
        let _guard = BRANCH_OPERATION.lock().map_err(|error| error.to_string())?;
        branch_action(&directory, &action, &expected)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn git_snapshot(directory: String) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot(&directory))
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
        diff(&directory, &path, &mode, reference.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn git_history(directory: String, skip: u32) -> Result<Vec<Commit>, String> {
    tauri::async_runtime::spawn_blocking(move || history(&directory, skip))
        .await
        .map_err(|error| error.to_string())?
}
fn history(directory: &str, skip: u32) -> Result<Vec<Commit>, String> {
    if skip > 100_000 {
        return Err("请在终端中查看更早的提交。".into());
    }
    if run(&directory, &["rev-parse", "--verify", "HEAD"]).is_err() {
        snapshot(&directory)?;
        return Ok(vec![]);
    }
    let output = run(
        &directory,
        &[
            "log",
            "-100",
            &format!("--skip={skip}"),
            "--topo-order",
            "--no-show-signature",
            "--no-notes",
            "--format=%H%x00%s%x00%an%x00%aI%x00%P%x00%B%x00",
        ],
    )?;
    if output.len() > LIMIT {
        return Err("提交信息过大，请在终端中查看 git log。".into());
    }
    let raw = String::from_utf8_lossy(&output);
    let fields: Vec<_> = raw.split('\0').collect();
    Ok(fields
        .chunks(6)
        .filter(|parts| parts.len() == 6)
        .map(|parts| Commit {
            id: parts[0].trim().into(),
            subject: parts[1].into(),
            message: parts[5].trim_end_matches('\n').into(),
            author: parts[2].into(),
            timestamp: parts[3].into(),
            parents: parts[4].split_whitespace().map(String::from).collect(),
        })
        .collect())
}
#[tauri::command]
pub async fn git_files(
    directory: String,
    reference: String,
    compare: bool,
) -> Result<Vec<Change>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let reference = revision(&directory, &reference)?;
        let output = if compare {
            run(
                &directory,
                &[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--name-status",
                    "--no-renames",
                    "-z",
                    &format!("{reference}...HEAD"),
                ],
            )?
        } else {
            run(
                &directory,
                &[
                    "show",
                    "--format=",
                    "--first-parent",
                    "--name-status",
                    "--no-renames",
                    "-r",
                    "-z",
                    &reference,
                ],
            )?
        };
        if output.len() > LIMIT {
            return Err("文件列表过大，请在终端中查看。".into());
        }
        let raw = std::str::from_utf8(&output).map_err(|_| "Git 路径包含无法显示的字符。")?;
        let parts: Vec<_> = raw.split('\0').filter(|part| !part.is_empty()).collect();
        Ok(parts
            .chunks_exact(2)
            .map(|parts| Change {
                path: parts[1].into(),
                original: None,
                index: parts[0].into(),
                working: " ".into(),
            })
            .collect())
    })
    .await
    .map_err(|error| error.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_retains_multiline_messages_metadata_and_page_offsets() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        let parent = revision(directory, "HEAD").unwrap();
        let message = "feat: show commit details\n\nShow full messages and changed files.\n显示完整提交信息和变动文件。\n\n- Preserve paragraphs, <tags> and \u{1f} separators.";
        std::fs::write(temp.path().join("file.txt"), "changed\n").unwrap();
        run(
            directory,
            &[
                "-c",
                "user.name=Test Author",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--no-gpg-sign",
                "--cleanup=verbatim",
                "-am",
                message,
            ],
        )
        .unwrap();
        let id = revision(directory, "HEAD").unwrap();
        let commits = history(directory, 0).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].id, id);
        assert_eq!(commits[0].subject, "feat: show commit details");
        assert_eq!(commits[0].message, message);
        assert_eq!(commits[0].author, "Test Author");
        assert!(!commits[0].timestamp.is_empty());
        assert_eq!(commits[0].parents, vec![parent.clone()]);
        assert!(commits[1].parents.is_empty());
        assert_eq!(commits[1].message, "fixture");
        let older = history(directory, 1).unwrap();
        assert_eq!(older.len(), 1);
        assert_eq!(older[0].id, parent);
        assert!(history(directory, 2).unwrap().is_empty());
    }

    #[test]
    fn history_reports_oversized_messages_instead_of_partial_records() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        let path = temp.path().join(".git/large-message.txt");
        std::fs::write(&path, "x".repeat(LIMIT + 1)).unwrap();
        run(
            directory,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--no-gpg-sign",
                "--allow-empty",
                "-F",
                path.to_str().unwrap(),
            ],
        )
        .unwrap();
        assert_eq!(
            history(directory, 0).err().unwrap(),
            "提交信息过大，请在终端中查看 git log。"
        );
    }

    fn branch_fixture() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().to_str().unwrap();
        run(directory, &["init", "--initial-branch=main"]).unwrap();
        run(directory, &["config", "core.autocrlf", "false"]).unwrap();
        std::fs::write(temp.path().join("file.txt"), "main\n").unwrap();
        run(directory, &["add", "."]).unwrap();
        fixture_commit(directory);
        run(directory, &["branch", "feature/中文"]).unwrap();
        temp
    }
    fn fixture_commit(directory: &str) {
        run(
            directory,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--no-gpg-sign",
                "-am",
                "fixture",
            ],
        )
        .unwrap();
    }
    fn rollback_target(directory: &str, path: &str) -> (Change, Option<String>) {
        let mut snapshot = snapshot(directory).unwrap();
        let change = snapshot.changes.remove(
            snapshot
                .changes
                .iter()
                .position(|change| change.path == path)
                .unwrap(),
        );
        (change, snapshot.head)
    }
    #[test]
    fn rollback_restores_staged_and_working_content_without_touching_other_files() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        std::fs::write(temp.path().join("file.txt"), "staged\n").unwrap();
        run(directory, &["add", "file.txt"]).unwrap();
        std::fs::write(temp.path().join("file.txt"), "working\n").unwrap();
        std::fs::write(temp.path().join("keep.txt"), "keep\n").unwrap();
        let (change, head) = rollback_target(directory, "file.txt");
        rollback_file(directory, &change, head.as_deref()).unwrap();
        assert_eq!(
            std::fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "main\n"
        );
        assert_eq!(
            text(run(directory, &["show", ":file.txt"]).unwrap()),
            "main"
        );
        assert_eq!(snapshot(directory).unwrap().changes.len(), 1);
        assert_eq!(
            std::fs::read_to_string(temp.path().join("keep.txt")).unwrap(),
            "keep\n"
        );
        std::fs::remove_file(temp.path().join("file.txt")).unwrap();
        run(directory, &["add", "file.txt"]).unwrap();
        let (change, head) = rollback_target(directory, "file.txt");
        rollback_file(directory, &change, head.as_deref()).unwrap();
        assert_eq!(
            std::fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "main\n"
        );
    }
    #[test]
    fn rollback_removes_added_files_with_literal_names_and_supports_unborn_repositories() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        for staged in [false, true] {
            let name = "-中文 [file].txt";
            std::fs::write(temp.path().join(name), "new\n").unwrap();
            if staged {
                run(directory, &["add", "--", name]).unwrap();
            }
            let (change, head) = rollback_target(directory, name);
            rollback_file(directory, &change, head.as_deref()).unwrap();
            assert!(!temp.path().join(name).exists());
            assert!(snapshot(directory).unwrap().changes.is_empty());
        }
        let unborn = tempfile::tempdir().unwrap();
        let directory = unborn.path().to_str().unwrap();
        run(directory, &["init", "--initial-branch=main"]).unwrap();
        std::fs::write(unborn.path().join("new.txt"), "new").unwrap();
        run(directory, &["add", "new.txt"]).unwrap();
        let (change, head) = rollback_target(directory, "new.txt");
        assert!(head.is_none());
        rollback_file(directory, &change, None).unwrap();
        assert!(!unborn.path().join("new.txt").exists());
        assert!(snapshot(directory).unwrap().changes.is_empty());
    }
    #[test]
    fn rollback_restores_renames_and_rejects_stale_state_or_commits() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        run(directory, &["mv", "file.txt", "renamed 中文.txt"]).unwrap();
        let (change, head) = rollback_target(directory, "renamed 中文.txt");
        assert_eq!(change.original.as_deref(), Some("file.txt"));
        rollback_file(directory, &change, head.as_deref()).unwrap();
        assert!(!temp.path().join("renamed 中文.txt").exists());
        assert_eq!(
            std::fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "main\n"
        );
        std::fs::write(temp.path().join("file.txt"), "keep\n").unwrap();
        let (change, head) = rollback_target(directory, "file.txt");
        run(directory, &["add", "file.txt"]).unwrap();
        assert!(rollback_file(directory, &change, head.as_deref())
            .unwrap_err()
            .contains("文件状态已改变"));
        let (change, head) = rollback_target(directory, "file.txt");
        fixture_commit(directory);
        assert!(rollback_file(directory, &change, head.as_deref())
            .unwrap_err()
            .contains("当前提交已改变"));
        assert_eq!(
            std::fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "keep\n"
        );
    }
    #[test]
    fn rollback_rejects_paths_outside_selected_directory_and_directory_targets() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        let selected = temp.path().join("selected");
        std::fs::create_dir(&selected).unwrap();
        std::fs::write(temp.path().join("file.txt"), "keep\n").unwrap();
        let (change, head) = rollback_target(directory, "file.txt");
        assert!(
            rollback_file(selected.to_str().unwrap(), &change, head.as_deref())
                .unwrap_err()
                .contains("所选目录")
        );
        for path in ["../escape", ".git/config", "", directory] {
            assert!(rollback_path(temp.path(), temp.path(), path).is_err());
        }
        run(directory, &["rm", "--force", "file.txt"]).unwrap();
        std::fs::create_dir(temp.path().join("file.txt")).unwrap();
        std::fs::write(temp.path().join("file.txt/keep.txt"), "keep").unwrap();
        let (change, head) = rollback_target(directory, "file.txt");
        assert!(rollback_file(directory, &change, head.as_deref()).is_err());
        assert!(temp.path().join("file.txt/keep.txt").exists());
    }
    #[test]
    fn rollback_rejects_links_submodules_and_rename_collisions() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        run(directory, &["mv", "file.txt", "new.txt"]).unwrap();
        std::fs::write(temp.path().join("file.txt"), "keep new original\n").unwrap();
        let (change, head) = rollback_target(directory, "new.txt");
        assert!(rollback_file(directory, &change, head.as_deref()).is_err());
        assert_eq!(
            std::fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "keep new original\n"
        );
        let commit = revision(directory, "HEAD").unwrap();
        let blob = text(run(directory, &["rev-parse", "HEAD:file.txt"]).unwrap());
        for (mode, object) in [("120000", blob.as_str()), ("160000", commit.as_str())] {
            run(
                directory,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    mode,
                    object,
                    "special",
                ],
            )
            .unwrap();
            let (change, head) = rollback_target(directory, "special");
            assert!(rollback_file(directory, &change, head.as_deref())
                .unwrap_err()
                .contains("链接和子模块"));
        }
    }
    #[test]
    fn branch_picker_lists_only_local_branches_and_switches_from_detached_head() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        run(directory, &["tag", "tag-only"]).unwrap();
        run(
            directory,
            &["update-ref", "refs/remotes/origin/remote-only", "HEAD"],
        )
        .unwrap();
        assert_eq!(
            branches(directory).unwrap().local,
            vec!["feature/中文", "main"]
        );
        switch_branch(directory, "feature/中文", "main").unwrap();
        assert_eq!(
            current_branch(directory).unwrap().as_deref(),
            Some("feature/中文")
        );
        run(directory, &["checkout", "--detach"]).unwrap();
        let detached = current_branch(directory).unwrap().unwrap();
        switch_branch(directory, "main", &detached).unwrap();
        assert_eq!(current_branch(directory).unwrap().as_deref(), Some("main"));
    }
    #[test]
    fn branch_switch_preserves_conflicting_changes_and_rejects_stale_or_nonlocal_targets() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        switch_branch(directory, "feature/中文", "main").unwrap();
        std::fs::write(temp.path().join("file.txt"), "feature\n").unwrap();
        fixture_commit(directory);
        switch_branch(directory, "main", "feature/中文").unwrap();
        for target in ["--discard-changes", "HEAD~1", "missing", "origin/main"] {
            assert!(switch_branch(directory, target, "main").is_err());
        }
        assert!(switch_branch(directory, "feature/中文", "stale").is_err());
        std::fs::write(temp.path().join("file.txt"), "unsaved work\n").unwrap();
        assert!(switch_branch(directory, "feature/中文", "main").is_err());
        assert_eq!(
            std::fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "unsaved work\n"
        );
        assert_eq!(current_branch(directory).unwrap().as_deref(), Some("main"));
    }
    #[test]
    fn branch_switch_respects_worktree_ownership_and_unborn_repositories() {
        let empty = tempfile::tempdir().unwrap();
        let directory = empty.path().to_str().unwrap();
        assert!(branches(directory).unwrap().current.is_none());
        run(directory, &["init", "--initial-branch=main"]).unwrap();
        let unborn = branches(directory).unwrap();
        assert_eq!(unborn.current.as_deref(), Some("main"));
        assert!(unborn.local.is_empty());
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        let worktree = temp.path().join("linked");
        run(
            directory,
            &[
                "worktree",
                "add",
                worktree.to_str().unwrap(),
                "feature/中文",
            ],
        )
        .unwrap();
        assert!(switch_branch(directory, "feature/中文", "main").is_err());
        run(directory, &["branch", "other"]).unwrap();
        switch_branch(worktree.to_str().unwrap(), "other", "feature/中文").unwrap();
        assert_eq!(current_branch(directory).unwrap().as_deref(), Some("main"));
        assert_eq!(
            current_branch(worktree.to_str().unwrap())
                .unwrap()
                .as_deref(),
            Some("other")
        );
    }
    fn remote_fixture(directory: &str) -> tempfile::TempDir {
        let remote = tempfile::tempdir().unwrap();
        run(
            remote.path().to_str().unwrap(),
            &["init", "--bare", "--initial-branch=main"],
        )
        .unwrap();
        run(
            directory,
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        )
        .unwrap();
        run(directory, &["push", "--set-upstream", "origin", "main"]).unwrap();
        remote
    }
    #[test]
    fn remote_listing_reads_unfetched_heads_and_keeps_partial_failures_visible() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        let _remote = remote_fixture(directory);
        run(
            directory,
            &["push", "origin", "feature/中文:refs/heads/remote/中文"],
        )
        .unwrap();
        run(
            directory,
            &["update-ref", "-d", "refs/remotes/origin/remote/中文"],
        )
        .unwrap();
        run(
            directory,
            &[
                "remote",
                "add",
                "unavailable",
                temp.path().join("missing").to_str().unwrap(),
            ],
        )
        .unwrap();
        let listed = remote_branches(directory).unwrap();
        assert_eq!(
            listed
                .branches
                .iter()
                .map(|b| b.branch.as_str())
                .collect::<Vec<_>>(),
            vec!["main", "remote/中文"]
        );
        assert_eq!(listed.errors.len(), 1);
        assert!(listed.errors[0].starts_with("unavailable:"));
        assert!(run(
            directory,
            &["show-ref", "--verify", "refs/remotes/origin/remote/中文"]
        )
        .is_err());
        assert!(!branches(directory)
            .unwrap()
            .local
            .contains(&"remote/中文".into()));
    }
    #[test]
    fn remote_switch_creates_tracking_and_rejects_collisions_stale_targets_and_conflicts() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        let _remote = remote_fixture(directory);
        switch_branch(directory, "feature/中文", "main").unwrap();
        std::fs::write(temp.path().join("file.txt"), "remote change\n").unwrap();
        fixture_commit(directory);
        run(
            directory,
            &["push", "origin", "HEAD:refs/heads/remote/中文"],
        )
        .unwrap();
        switch_branch(directory, "main", "feature/中文").unwrap();
        assert!(switch_remote_branch(directory, "origin", "remote/中文", "stale").is_err());
        assert!(switch_remote_branch(directory, "--force", "main", "main").is_err());
        assert!(switch_remote_branch(directory, "origin", "--force", "main").is_err());
        std::fs::write(temp.path().join("file.txt"), "keep draft\n").unwrap();
        assert!(switch_remote_branch(directory, "origin", "remote/中文", "main").is_err());
        assert_eq!(
            std::fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "keep draft\n"
        );
        assert!(!branches(directory)
            .unwrap()
            .local
            .contains(&"remote/中文".into()));
        run(directory, &["restore", "file.txt"]).unwrap();
        run(
            directory,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/main:refs/remotes/origin/main",
            ],
        )
        .unwrap();
        switch_remote_branch(directory, "origin", "remote/中文", "main").unwrap();
        assert_eq!(
            current_branch(directory).unwrap().as_deref(),
            Some("remote/中文")
        );
        assert_eq!(
            text(run(directory, &["config", "branch.remote/中文.merge"]).unwrap()),
            "refs/heads/remote/中文"
        );
        switch_branch(directory, "main", "remote/中文").unwrap();
        switch_remote_branch(directory, "origin", "remote/中文", "main").unwrap();
        switch_branch(directory, "main", "remote/中文").unwrap();
        run(
            directory,
            &["config", "branch.remote/中文.merge", "refs/heads/other"],
        )
        .unwrap();
        assert!(switch_remote_branch(directory, "origin", "remote/中文", "main").is_err());
    }
    #[test]
    fn pull_preserves_unrelated_staged_working_and_untracked_changes() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        std::fs::write(temp.path().join("local.txt"), "original\n").unwrap();
        run(directory, &["add", "local.txt"]).unwrap();
        fixture_commit(directory);
        let remote = remote_fixture(directory);
        let other = tempfile::tempdir().unwrap();
        let other_dir = other.path().to_str().unwrap();
        run(other_dir, &["clone", remote.path().to_str().unwrap(), "."]).unwrap();
        std::fs::write(temp.path().join("local.txt"), "staged\n").unwrap();
        run(directory, &["add", "local.txt"]).unwrap();
        std::fs::write(temp.path().join("local.txt"), "working\n").unwrap();
        std::fs::write(temp.path().join("untracked.txt"), "untracked\n").unwrap();
        let index = run(directory, &["diff", "--cached"]).unwrap();
        let before = revision(directory, "HEAD").unwrap();
        branch_action(directory, "pull", "main").unwrap();
        assert_eq!(revision(directory, "HEAD").unwrap(), before);
        std::fs::write(other.path().join("file.txt"), "remote change\n").unwrap();
        fixture_commit(other_dir);
        branch_action(other_dir, "push", "main").unwrap();
        branch_action(directory, "pull", "main").unwrap();
        assert_eq!(
            revision(directory, "HEAD").unwrap(),
            revision(other_dir, "HEAD").unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "remote change\n"
        );
        assert_eq!(run(directory, &["diff", "--cached"]).unwrap(), index);
        assert_eq!(
            std::fs::read_to_string(temp.path().join("local.txt")).unwrap(),
            "working\n"
        );
        assert_eq!(
            std::fs::read_to_string(temp.path().join("untracked.txt")).unwrap(),
            "untracked\n"
        );
    }
    #[test]
    fn pull_rejects_overwriting_staged_working_or_untracked_files_without_autostash() {
        for kind in ["staged", "working", "untracked"] {
            let temp = branch_fixture();
            let directory = temp.path().to_str().unwrap();
            let remote = remote_fixture(directory);
            let other = tempfile::tempdir().unwrap();
            let other_dir = other.path().to_str().unwrap();
            run(other_dir, &["clone", remote.path().to_str().unwrap(), "."]).unwrap();
            std::fs::write(other.path().join("file.txt"), "remote change\n").unwrap();
            std::fs::write(other.path().join("new.txt"), "remote addition\n").unwrap();
            run(other_dir, &["add", "new.txt"]).unwrap();
            fixture_commit(other_dir);
            branch_action(other_dir, "push", "main").unwrap();
            let path = if kind == "untracked" {
                "new.txt"
            } else {
                "file.txt"
            };
            std::fs::write(temp.path().join(path), "local change\n").unwrap();
            if kind == "staged" {
                run(directory, &["add", path]).unwrap();
            }
            run(directory, &["config", "merge.autostash", "true"]).unwrap();
            let index = run(directory, &["diff", "--cached"]).unwrap();
            let before = revision(directory, "HEAD").unwrap();
            assert!(branch_action(directory, "pull", "main").is_err());
            assert_eq!(revision(directory, "HEAD").unwrap(), before);
            assert_eq!(run(directory, &["diff", "--cached"]).unwrap(), index);
            assert_eq!(
                std::fs::read_to_string(temp.path().join(path)).unwrap(),
                "local change\n"
            );
            assert!(run(directory, &["stash", "list"]).unwrap().is_empty());
        }
    }
    #[test]
    fn sync_uses_explicit_upstream_rejects_diverged_pull_and_never_force_pushes() {
        let temp = branch_fixture();
        let directory = temp.path().to_str().unwrap();
        assert!(branch_action(directory, "push", "main").is_err());
        let remote = remote_fixture(directory);
        let other = tempfile::tempdir().unwrap();
        let other_dir = other.path().to_str().unwrap();
        run(other_dir, &["clone", remote.path().to_str().unwrap(), "."]).unwrap();
        std::fs::write(temp.path().join("file.txt"), "local change\n").unwrap();
        branch_action(directory, "pull", "main").unwrap();
        assert_eq!(
            std::fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "local change\n"
        );
        fixture_commit(directory);
        branch_action(directory, "push", "main").unwrap();
        branch_action(other_dir, "pull", "main").unwrap();
        assert_eq!(
            revision(directory, "HEAD").unwrap(),
            revision(other_dir, "HEAD").unwrap()
        );
        std::fs::write(other.path().join("file.txt"), "remote change\n").unwrap();
        fixture_commit(other_dir);
        branch_action(other_dir, "push", "main").unwrap();
        branch_action(directory, "pull", "main").unwrap();
        assert_eq!(
            revision(directory, "HEAD").unwrap(),
            revision(other_dir, "HEAD").unwrap()
        );
        std::fs::write(other.path().join("file.txt"), "diverged remote\n").unwrap();
        fixture_commit(other_dir);
        branch_action(other_dir, "push", "main").unwrap();
        std::fs::write(temp.path().join("file.txt"), "diverged local\n").unwrap();
        fixture_commit(directory);
        let before = revision(directory, "HEAD").unwrap();
        assert!(branch_action(directory, "pull", "main").is_err());
        assert_eq!(revision(directory, "HEAD").unwrap(), before);
        run(
            directory,
            &["config", "remote.origin.push", "+refs/heads/*:refs/heads/*"],
        )
        .unwrap();
        assert!(branch_action(directory, "push", "main").is_err());
        assert_eq!(
            revision(remote.path().to_str().unwrap(), "main").unwrap(),
            revision(other_dir, "HEAD").unwrap()
        );
        branch_action(directory, "fetch", "main").unwrap();
        assert_eq!(revision(directory, "HEAD").unwrap(), before);
        assert!(branch_action(directory, "reset", "main").is_err());
        assert!(branch_action(directory, "pull", "stale").is_err());
    }
    #[test]
    fn branch_label_handles_unborn_switches_and_detached_head() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().to_str().unwrap();
        assert_eq!(current_branch(directory).unwrap(), None);
        run(directory, &["init", "--initial-branch=main"]).unwrap();
        assert_eq!(current_branch(directory).unwrap().as_deref(), Some("main"));
        run(
            directory,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ],
        )
        .unwrap();
        run(directory, &["switch", "-c", "feature/header"]).unwrap();
        assert_eq!(
            current_branch(directory).unwrap().as_deref(),
            Some("feature/header")
        );
        run(directory, &["checkout", "--detach"]).unwrap();
        assert!(current_branch(directory)
            .unwrap()
            .unwrap()
            .starts_with("HEAD · "));
    }
    #[test]
    fn status_retains_renames_unicode_and_newlines() {
        let files = status(b" M a b\0R  new\nname\0old name\0?? \xe4\xb8\xad\xe6\x96\x87\0")
            .expect("status");
        assert_eq!(files.len(), 3);
        assert_eq!(files[1].original.as_deref(), Some("old name"));
        assert_eq!(files[1].path, "new\nname");
        assert_eq!(files[2].path, "中文");
    }
    #[test]
    fn working_and_staged_diff_are_separate_and_do_not_modify_index() {
        let root = std::env::temp_dir().join(format!(
            "uterm-git-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("fixture");
        let directory = root.to_str().expect("directory");
        run(directory, &["init", "-b", "main"]).expect("init");
        std::fs::write(root.join("file name"), "base\n").expect("file");
        run(directory, &["add", "."]).expect("add");
        run(
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
                "-m",
                "fixture",
            ],
        )
        .expect("commit");
        std::fs::write(root.join("file name"), "staged\n").expect("file");
        run(directory, &["add", "."]).expect("stage");
        std::fs::write(root.join("file name"), "working\n").expect("file");
        let before = run(directory, &["ls-files", "--stage"]).expect("index");
        assert!(diff(directory, "file name", "staged", None)
            .expect("staged")
            .text
            .contains("+staged"));
        assert!(diff(directory, "file name", "working", None)
            .expect("working")
            .text
            .contains("+working"));
        assert_eq!(
            before,
            run(directory, &["ls-files", "--stage"]).expect("index")
        );
        assert!(diff(directory, "../outside", "working", None).is_err());
        assert!(revision(directory, "--output=/tmp/no").is_err());
        std::fs::write(root.join("new file"), "first\nlast").expect("untracked file");
        let added = diff(directory, "new file", "working", None).expect("untracked diff");
        assert!(added
            .text
            .contains("@@ -0,0 +1,2 @@\n+first\n+last\n\\ No newline at end of file"));
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
