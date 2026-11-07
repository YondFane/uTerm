use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use uterm_core::files::{copy_between_roots, list, mutate_file, read, resolve, save, search};
pub use uterm_core::files::{
    FileDocument as Document, FileListing as Listing, FileSearch as Search,
};

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

#[tauri::command]
pub async fn file_copy(
    app: tauri::AppHandle,
    directory: String,
    source_directory: String,
    path: String,
    destination: String,
) -> Result<(), String> {
    let operation = crate::content_operations::begin(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        copy_between_roots(&source_directory, &path, &directory, &destination)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn file_mutate(
    app: tauri::AppHandle,
    directory: String,
    path: String,
    action: String,
    name: String,
) -> Result<(), String> {
    let operation = crate::content_operations::begin(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        mutate_file(&directory, &path, &action, &name)
    })
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
    app: tauri::AppHandle,
    directory: String,
    path: String,
    text: String,
    expected: String,
    force: bool,
) -> Result<String, String> {
    let operation = crate::content_operations::begin(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        save(&directory, &path, &text, &expected, force)
    })
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
