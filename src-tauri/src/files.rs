use base64::Engine;
use ignore::WalkBuilder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::Manager;

const TEXT_LIMIT: usize = 2 * 1024 * 1024;
const PREVIEW_LIMIT: usize = 8 * 1024 * 1024;
static WRITES: Mutex<()> = Mutex::new(());
#[derive(Default)]
pub struct EditorGuard(pub AtomicBool);
#[tauri::command]
pub fn editor_guard(app: tauri::AppHandle, active: bool) {
    app.state::<EditorGuard>().0.store(active, Ordering::SeqCst);
}
#[tauri::command]
pub fn editor_exit(app: tauri::AppHandle) {
    app.state::<EditorGuard>().0.store(false, Ordering::SeqCst);
    app.exit(0);
}

#[cfg(target_os = "windows")]
pub fn menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    // Tauri's default Windows menu is rendered as a separate, light Win32 menu bar.
    // uTerm exposes its commands in the application UI, so keep that chrome out
    // of the dark workspace instead of showing empty File/Edit/Window/Help menus.
    tauri::menu::Menu::new(app)
}

#[cfg(not(target_os = "windows"))]
pub fn menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
    let menu = Menu::default(app)?;
    // macOS's predefined Quit invokes terminate: without a cancellable ExitRequested event.
    let quit_label = PredefinedMenuItem::quit(app, None)?.text()?;
    let close_label = PredefinedMenuItem::close_window(app, None)?.text()?;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item {
            for (index, item) in submenu.items()?.into_iter().enumerate() {
                if let MenuItemKind::Predefined(predefined) = item {
                    if predefined.text()? == close_label {
                        submenu.remove(&predefined)?;
                        submenu.insert(
                            &MenuItem::with_id(
                                app,
                                "desktop-window-close",
                                &close_label,
                                true,
                                None::<&str>,
                            )?,
                            index,
                        )?;
                    }
                    if predefined.text()? == quit_label {
                        submenu.remove(&predefined)?;
                        submenu.insert(
                            &MenuItem::with_id(
                                app,
                                "editor-quit",
                                &quit_label,
                                true,
                                if cfg!(target_os = "macos") {
                                    Some("Cmd+Q")
                                } else {
                                    None
                                },
                            )?,
                            index,
                        )?;
                    }
                }
            }
        }
    }
    Ok(menu)
}

fn resolve(directory: &str, relative: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = Path::new(directory)
        .canonicalize()
        .map_err(|error| format!("无法打开项目目录：{error}"))?;
    if !root.is_dir()
        || Path::new(relative)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("文件路径无效。".into());
    }
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("无法打开文件：{error}"))?;
    if !path.starts_with(&root) {
        return Err("链接指向项目目录以外，无法在此打开。".into());
    }
    Ok((root, path))
}
fn read_bytes(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("仅支持普通文件。".into());
    }
    if metadata.len() > limit as u64 {
        return Err("文件过大，请使用外部编辑器打开。".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err("文件过大，请使用外部编辑器打开。".into());
    }
    Ok(bytes)
}

fn mutate_file(directory: &str, path: &str, action: &str, name: &str) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|error| error.to_string())?;
    let (root, target) = resolve(directory, path)?;
    // Mutations must never follow a link to an unrelated file or directory.
    let mut cursor = root.clone();
    for part in Path::new(path).components() {
        cursor.push(part);
        if std::fs::symlink_metadata(&cursor)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("链接及链接内的文件不能在此修改。".into());
        }
    }
    if action == "delete" {
        if target == root {
            return Err("不能删除项目根目录。".into());
        }
        // Nonempty directories require their contents to be removed explicitly.
        return if target.is_dir() {
            std::fs::remove_dir(target)
        } else {
            std::fs::remove_file(target)
        }
        .map_err(|error| format!("删除失败（目录必须为空）：{error}"));
    }
    if name.trim().is_empty()
        || name != name.trim()
        || name.contains(['/', '\\', ':'])
        || name == "."
        || name == ".."
    {
        return Err("请输入不含路径分隔符的名称。".into());
    }
    let parent = match action {
        "file" | "directory" if target.is_dir() => target.as_path(),
        "rename" if target != root => target.parent().ok_or("无法读取父目录。")?,
        _ => return Err("文件操作无效。".into()),
    };
    let destination = parent.join(name);
    // An unchanged rename is a no-op, not a collision with itself.
    // 名称未改变的重命名无需操作，不应被判定为与自身冲突。
    if action == "rename" && target.file_name() == Some(std::ffi::OsStr::new(name)) {
        return Ok(());
    }
    if let Ok(existing) = std::fs::symlink_metadata(&destination) {
        let message = match (action, target.is_dir(), existing.is_dir()) {
            ("file", _, true) => "无法新建文件：同名目录已存在。",
            ("file", _, false) => "无法新建文件：同名文件或链接已存在。",
            ("directory", _, true) => "无法新建目录：同名目录已存在。",
            ("directory", _, false) => "无法新建目录：同名文件或链接已存在。",
            ("rename", true, true) => "无法重命名目录：目标目录名称已存在。",
            ("rename", true, false) => "无法重命名目录：目标名称被文件或链接占用。",
            ("rename", false, true) => "无法重命名文件：目标名称被目录占用。",
            _ => "无法重命名文件：目标文件或链接名称已存在。",
        };
        return Err(message.into());
    }
    match action {
        "file" => std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)
            .map(|_| ()),
        "directory" => std::fs::create_dir(destination),
        "rename" => std::fs::rename(target, destination),
        _ => unreachable!(),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn file_mutate(
    directory: String,
    path: String,
    action: String,
    name: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || mutate_file(&directory, &path, &action, &name))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn file_reveal(
    app: tauri::AppHandle,
    directory: String,
    path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_opener::OpenerExt;
        // Resolve within the selected root before handing the path to the OS.
        // 交给系统打开之前，先确保路径位于所选根目录内。
        let (_, target) = resolve(&directory, &path)?;
        if target.is_dir() {
            app.opener()
                .open_path(target.to_string_lossy(), None::<&str>)
        } else {
            app.opener().reveal_item_in_dir(target)
        }
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
fn version(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn walker(path: &Path, hidden: bool, depth: Option<usize>) -> ignore::Walk {
    WalkBuilder::new(path)
        .hidden(!hidden)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .require_git(false)
        .follow_links(false)
        .max_depth(depth)
        .filter_entry(|entry| {
            entry.depth() == 0
                || (entry.file_name() != ".git"
                    && !entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".uterm-editor-"))
        })
        .build()
}
#[derive(Serialize)]
pub struct Entry {
    path: String,
    name: String,
    directory: bool,
    symlink: bool,
}
#[derive(Serialize)]
pub struct Listing {
    entries: Vec<Entry>,
    partial: bool,
    skipped: usize,
}
fn list(directory: &str, relative: &str, hidden: bool) -> Result<Listing, String> {
    let (root, folder) = resolve(directory, relative)?;
    if !folder.is_dir() {
        return Err("这不是目录。".into());
    }
    let mut result = Listing {
        entries: vec![],
        partial: false,
        skipped: 0,
    };
    for item in walker(&folder, hidden, Some(1)).skip(1) {
        let item = match item {
            Ok(item) => item,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        let Some(kind) = item.file_type() else {
            result.skipped += 1;
            continue;
        };
        if !kind.is_dir() && !kind.is_file() && !kind.is_symlink() {
            continue;
        }
        let Some(name) = item.file_name().to_str() else {
            result.skipped += 1;
            continue;
        };
        // Keep lexical paths through in-root symlinks so the tree remains navigable.
        let path = if relative.is_empty() {
            name.to_owned()
        } else {
            format!("{relative}/{name}")
        };
        let is_directory = kind.is_dir()
            || (kind.is_symlink()
                && resolve(root.to_str().ok_or("目录名称无效。")?, &path)
                    .is_ok_and(|(_, target)| target.is_dir()));
        result.entries.push(Entry {
            path,
            name: name.into(),
            directory: is_directory,
            symlink: kind.is_symlink(),
        });
        if result.entries.len() >= 2000 {
            result.partial = true;
            break;
        }
    }
    result.entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(result)
}
#[derive(Serialize)]
pub struct Document {
    kind: String,
    text: String,
    version: String,
    line_ending: String,
    bom: bool,
    readonly: bool,
    notice: Option<String>,
}
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}
fn is_pdf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-")
}
fn read(directory: &str, relative: &str) -> Result<Document, String> {
    let (_, path) = resolve(directory, relative)?;
    if !path.is_file() {
        return Err("仅支持普通文件。".into());
    }
    let bytes = read_bytes(&path, PREVIEW_LIMIT)?;
    let digest = version(&bytes);
    if let Some(kind) = image_type(&bytes) {
        return Ok(Document {
            kind: "image".into(),
            text: format!(
                "data:{kind};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
            version: digest,
            line_ending: "\n".into(),
            bom: false,
            readonly: true,
            notice: None,
        });
    }
    if is_pdf(&bytes) {
        return Ok(Document {
            kind: "pdf".into(),
            text: format!(
                "data:application/pdf;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
            version: digest,
            line_ending: "\n".into(),
            bom: false,
            readonly: true,
            notice: None,
        });
    }
    if bytes.len() > TEXT_LIMIT {
        return Err("文本超过 2 MB，请使用外部编辑器打开。".into());
    }
    if bytes.contains(&0) {
        return Err("这是二进制文件，无法作为文本编辑。".into());
    }
    let bom = bytes.starts_with(b"\xef\xbb\xbf");
    let text = std::str::from_utf8(if bom { &bytes[3..] } else { &bytes })
        .map_err(|_| "文件不是 UTF-8 文本，无法在此编辑。")?
        .to_owned();
    let crlf = text.matches("\r\n").count();
    let cr = text.matches('\r').count();
    let lf = text.matches('\n').count();
    let mixed = (crlf > 0 && (cr != crlf || lf != crlf)) || (crlf == 0 && cr > 0 && lf > 0);
    let line_ending = if crlf > 0 {
        "\r\n"
    } else if cr > 0 {
        "\r"
    } else {
        "\n"
    }
    .into();
    let readonly = std::fs::metadata(path)
        .map_err(|error| error.to_string())?
        .permissions()
        .readonly()
        || mixed;
    Ok(Document {
        kind: "text".into(),
        text,
        version: digest,
        line_ending,
        bom,
        readonly,
        notice: mixed.then(|| "文件包含混合换行符，当前以只读方式打开。".into()),
    })
}
fn save(
    directory: &str,
    relative: &str,
    text: &str,
    expected: &str,
    force: bool,
) -> Result<String, String> {
    let _guard = WRITES.lock().map_err(|error| error.to_string())?;
    let (_, path) = resolve(directory, relative)?;
    if !path.is_file() {
        return Err("仅支持保存普通文件。".into());
    }
    let previous = read_bytes(&path, TEXT_LIMIT)?;
    if version(&previous) != expected && !force {
        return Err("CONFLICT:文件已被其他程序修改。请重新读取，或确认覆盖磁盘版本。".into());
    }
    if text.len() > TEXT_LIMIT || text.contains('\0') {
        return Err("内容超过 2 MB 或包含二进制字符，未保存。".into());
    }
    let permissions = std::fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .permissions();
    if permissions.readonly() {
        return Err("文件是只读的，未保存。".into());
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".uterm-editor-")
        .tempfile_in(path.parent().ok_or("文件路径无效。")?)
        .map_err(|error| error.to_string())?;
    temporary
        .write_all(text.as_bytes())
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .set_permissions(permissions)
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    if resolve(directory, relative)?.1 != path || read_bytes(&path, TEXT_LIMIT)? != previous {
        return Err("CONFLICT:保存期间文件发生变化，请重新读取。".into());
    }
    temporary
        .persist(&path)
        .map_err(|error| format!("保存失败，原文件已保留：{}", error.error))?;
    Ok(version(text.as_bytes()))
}
#[derive(Serialize)]
pub struct Match {
    path: String,
    line: usize,
    text: String,
}
#[derive(Serialize)]
pub struct Search {
    matches: Vec<Match>,
    partial: bool,
    skipped: usize,
}
fn search(
    directory: &str,
    query: &str,
    content: bool,
    sensitive: bool,
    hidden: bool,
) -> Result<Search, String> {
    let (root, _) = resolve(directory, "")?;
    if query.len() > 500 {
        return Err("搜索内容过长。".into());
    }
    let mut result = Search {
        matches: vec![],
        partial: false,
        skipped: 0,
    };
    if content && query.is_empty() {
        return Ok(result);
    }
    let needle = if sensitive {
        query.to_owned()
    } else {
        query.to_lowercase()
    };
    let started = Instant::now();
    let mut bytes_remaining = 32 * 1024 * 1024usize;
    for (index, item) in walker(&root, hidden, Some(40)).enumerate() {
        if index >= 30000 || started.elapsed() > Duration::from_secs(3) {
            result.partial = true;
            break;
        }
        let item = match item {
            Ok(item) => item,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        if !item.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Some(path) = item.path().strip_prefix(&root).ok().and_then(Path::to_str) else {
            result.skipped += 1;
            continue;
        };
        let path = path.replace(std::path::MAIN_SEPARATOR, "/");
        if !content {
            let candidate = if sensitive {
                path.clone()
            } else {
                path.to_lowercase()
            };
            if needle
                .split_whitespace()
                .all(|part| candidate.contains(part))
            {
                result.matches.push(Match {
                    path,
                    line: 0,
                    text: String::new(),
                });
            }
        } else {
            let bytes = match read_bytes(item.path(), 512 * 1024) {
                Ok(bytes) => bytes,
                Err(_) => {
                    result.skipped += 1;
                    continue;
                }
            };
            if bytes.len() > bytes_remaining {
                result.partial = true;
                break;
            }
            bytes_remaining -= bytes.len();
            if bytes.contains(&0) {
                continue;
            }
            let Ok(text) = std::str::from_utf8(&bytes) else {
                continue;
            };
            // Match the editor's line numbering for LF, CRLF, and CR files.
            // 对 LF、CRLF 和 CR 文件使用与编辑器一致的行号。
            let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
            for (line, value) in normalized.lines().enumerate() {
                let candidate = if sensitive {
                    value.to_owned()
                } else {
                    value.to_lowercase()
                };
                if candidate.contains(&needle) {
                    result.matches.push(Match {
                        path: path.clone(),
                        line: line + 1,
                        text: value.chars().take(240).collect(),
                    });
                    if result.matches.len() >= 300 {
                        break;
                    }
                }
            }
        }
        if result.matches.len() >= 300 {
            result.partial = true;
            break;
        }
    }
    if !content {
        result.matches.sort_by(|a, b| {
            a.path
                .len()
                .cmp(&b.path.len())
                .then_with(|| a.path.cmp(&b.path))
        });
    }
    Ok(result)
}
#[tauri::command]
pub async fn files_list(directory: String, path: String, hidden: bool) -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(move || list(&directory, &path, hidden))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn file_read(directory: String, path: String) -> Result<Document, String> {
    tauri::async_runtime::spawn_blocking(move || read(&directory, &path))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn file_save(
    directory: String,
    path: String,
    text: String,
    expected: String,
    force: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || save(&directory, &path, &text, &expected, force))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn files_search(
    directory: String,
    query: String,
    content: bool,
    sensitive: bool,
    hidden: bool,
) -> Result<Search, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search(&directory, &query, content, sensitive, hidden)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_management_rejects_root_traversal_overwrite_and_nonempty_delete() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().to_str().unwrap();
        mutate_file(root, "", "directory", "folder").unwrap();
        mutate_file(root, "folder", "file", "中文.txt").unwrap();
        assert!(mutate_file(root, "folder", "file", "中文.txt").is_err());
        assert!(mutate_file(root, "", "delete", "").is_err());
        assert!(mutate_file(root, "folder", "delete", "").is_err());
        assert!(mutate_file(root, "", "file", "../escape").is_err());
        assert!(mutate_file(root, "../", "file", "escape").is_err());
        mutate_file(root, "folder/中文.txt", "rename", "renamed.txt").unwrap();
        assert!(!fixture.path().join("folder/中文.txt").exists());
        mutate_file(root, "folder/renamed.txt", "delete", "").unwrap();
        mutate_file(root, "folder", "delete", "").unwrap();
        assert!(!fixture.path().join("folder").exists());
    }
    #[test]
    fn mutation_conflicts_distinguish_operations_and_allow_unchanged_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        mutate_file(root, "", "file", "a").unwrap();
        mutate_file(root, "", "directory", "b").unwrap();
        for action in ["file", "directory"] {
            let file_conflict = mutate_file(root, "", action, "a").unwrap_err();
            let folder_conflict = mutate_file(root, "", action, "b").unwrap_err();
            assert_ne!(file_conflict, folder_conflict);
        }
        assert_ne!(
            mutate_file(root, "a", "rename", "b").unwrap_err(),
            mutate_file(root, "b", "rename", "a").unwrap_err()
        );
        mutate_file(root, "a", "rename", "a").unwrap();
        mutate_file(root, "b", "rename", "b").unwrap();
        assert!(dir.path().join("a").is_file());
        assert!(dir.path().join("b").is_dir());
    }
    #[test]
    fn save_preserves_bytes_permissions_and_rejects_external_changes() {
        let dir = tempfile::tempdir().expect("fixture");
        let root = dir.path().to_str().expect("path");
        let path = dir.path().join("中文 file.txt");
        std::fs::write(&path, "\u{feff}first\r\nsecond\r\n").expect("fixture");
        let opened = read(root, "中文 file.txt").expect("read");
        assert!(opened.bom);
        assert_eq!(opened.line_ending, "\r\n");
        assert_eq!(opened.text, "first\r\nsecond\r\n");
        let saved = save(
            root,
            "中文 file.txt",
            "\u{feff}edited\r\n",
            &opened.version,
            false,
        )
        .expect("save");
        assert_eq!(
            std::fs::read(&path).expect("bytes"),
            "\u{feff}edited\r\n".as_bytes()
        );
        std::fs::write(&path, "outside").expect("external edit");
        assert!(save(root, "中文 file.txt", "overwrite", &saved, false)
            .expect_err("conflict")
            .starts_with("CONFLICT:"));
        assert_eq!(
            std::fs::read_to_string(&path).expect("preserved"),
            "outside"
        );
        save(root, "中文 file.txt", "confirmed", &saved, true).expect("explicit overwrite");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("mode");
            let opened = read(root, "中文 file.txt").expect("read");
            save(root, "中文 file.txt", "executable", &opened.version, false).expect("save");
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o755
            );
        }
    }
    #[test]
    fn search_obeys_ignores_and_returns_unicode_line_numbers() {
        let dir = tempfile::tempdir().expect("fixture");
        let root = dir.path().to_str().expect("path");
        std::fs::write(dir.path().join(".gitignore"), "ignored/\n").expect("ignore");
        std::fs::create_dir(dir.path().join("ignored")).expect("folder");
        std::fs::write(dir.path().join("ignored/file.txt"), "针").expect("file");
        std::fs::write(dir.path().join("visible.txt"), "first\n针 and NEEDLE\n").expect("file");
        std::fs::write(dir.path().join(".hidden"), "针").expect("hidden");
        let found = search(root, "针", true, false, false).expect("search");
        assert_eq!(found.matches.len(), 1);
        assert_eq!(found.matches[0].line, 2);
        assert_eq!(
            search(root, "needle", true, false, false)
                .expect("search")
                .matches
                .len(),
            1
        );
        assert!(search(root, "needle", true, true, false)
            .expect("search")
            .matches
            .is_empty());
        assert_eq!(
            search(root, "针", true, false, true)
                .expect("hidden")
                .matches
                .len(),
            2
        );
        assert!(list(root, "", false)
            .expect("list")
            .entries
            .iter()
            .all(|entry| entry.name != "ignored"));
    }
    #[test]
    fn search_line_numbers_match_all_supported_editor_line_endings() {
        let dir = tempfile::tempdir().expect("fixture");
        let root = dir.path().to_str().expect("path");
        for separator in ["\n", "\r\n", "\r"] {
            std::fs::write(
                dir.path().join("source.txt"),
                ["first", "", "needle", "last"].join(separator),
            )
            .expect("file");
            let found = search(root, "needle", true, true, false).expect("search");
            assert_eq!(found.matches.len(), 1);
            assert_eq!(found.matches[0].line, 3);
            assert_eq!(found.matches[0].text, "needle");
        }
    }
    #[test]
    fn rejects_traversal_binary_large_and_mixed_newlines() {
        let dir = tempfile::tempdir().expect("fixture");
        let root = dir.path().to_str().expect("path");
        assert!(resolve(root, "../outside").is_err());
        assert!(resolve(root, "/outside").is_err());
        std::fs::write(dir.path().join("binary"), [0, 1, 2]).expect("file");
        assert!(read(root, "binary").is_err());
        std::fs::write(dir.path().join("large"), vec![b'a'; TEXT_LIMIT + 1]).expect("file");
        assert!(read(root, "large").is_err());
        std::fs::write(dir.path().join("mixed"), "a\r\nb\nc").expect("file");
        assert!(read(root, "mixed").expect("mixed").readonly);
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().expect("outside");
            std::fs::write(outside.path().join("file"), "untouched").expect("file");
            std::os::unix::fs::symlink(outside.path().join("file"), dir.path().join("link"))
                .expect("link");
            assert!(read(root, "link").is_err());
            assert!(save(root, "link", "bad", "", true).is_err());
        }
    }
    #[test]
    fn reads_pdf_as_a_readonly_preview() {
        let dir = tempfile::tempdir().expect("fixture");
        let root = dir.path().to_str().expect("path");
        std::fs::write(dir.path().join("document.pdf"), b"%PDF-1.7\nexample").expect("file");

        let opened = read(root, "document.pdf").expect("read");

        assert_eq!(opened.kind, "pdf");
        assert!(opened.readonly);
        assert_eq!(
            opened.text,
            "data:application/pdf;base64,JVBERi0xLjcKZXhhbXBsZQ=="
        );
    }
}
