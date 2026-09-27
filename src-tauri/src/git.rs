use serde::Serialize;
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
#[derive(Debug, Serialize)]
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
    tauri::async_runtime::spawn_blocking(move || {
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
                "--format=%H%x00%s%x00%an%x00%aI%x00%P%x00",
            ],
        )?;
        let raw = String::from_utf8_lossy(&output);
        let fields: Vec<_> = raw.split('\0').collect();
        Ok(fields
            .chunks(5)
            .filter(|parts| parts.len() == 5)
            .map(|parts| Commit {
                id: parts[0].trim().into(),
                subject: parts[1].into(),
                author: parts[2].into(),
                timestamp: parts[3].into(),
                parents: parts[4].split_whitespace().map(String::from).collect(),
            })
            .collect())
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
