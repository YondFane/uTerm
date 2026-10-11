#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use tauri::{Emitter, Manager};
mod agent_install;
mod agents;
mod control;
mod files;
mod git;
mod github;
mod projects;
mod sessions;
mod taskbar;
mod updates;

#[tauri::command]
async fn autostart_configure(app: tauri::AppHandle, enabled: Option<bool>) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.autolaunch();
        if let Some(enabled) = enabled {
            if enabled {
                manager.enable()
            } else {
                manager.disable()
            }
            .map_err(|error| error.to_string())?;
        }
        manager.is_enabled().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
struct RuntimeInfo {
    platform: &'static str,
    architecture: &'static str,
    version: String,
    home: String,
    agents: Vec<String>,
    agent_definitions: Vec<utermd_local::agents::AgentDefinition>,
    debug: bool,
    chat_directory: String,
}

#[tauri::command]
fn runtime_info(app: tauri::AppHandle) -> Result<RuntimeInfo, String> {
    let chats = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("chats");
    std::fs::create_dir_all(&chats).map_err(|error| error.to_string())?;
    let definitions = utermd_local::agents::read(
        &app.path()
            .app_data_dir()
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let configuration = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let mut available: Vec<String> = ["codex", "claude", "gemini", "opencode", "kimi", "grok"]
        .into_iter()
        .map(String::from)
        .chain(definitions.iter().map(|item| item.id.clone()))
        .collect();
    available.sort();
    available.dedup();
    available.retain(|id| utermd_local::agents::resolve(&configuration, id).is_ok());
    Ok(RuntimeInfo {
        agents: available,
        agent_definitions: definitions,
        debug: cfg!(debug_assertions),
        chat_directory: chats.to_str().ok_or("聊天目录名称无法转换为文本。")?.into(),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        version: app.package_info().version.to_string(),
        home: std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default(),
    })
}

#[tauri::command]
async fn select_project_directory(
    window: tauri::WebviewWindow,
    directory: String,
    title: Option<String>,
) -> Result<Option<Vec<String>>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(title.as_deref().unwrap_or("Choose project directory"));
        if std::path::Path::new(&directory).is_dir() {
            dialog = dialog.set_directory(directory);
        }
        dialog
            .blocking_pick_folders()
            .map(|paths| {
                paths
                    .into_iter()
                    .map(|path| {
                        path.into_path()
                            .map_err(|error| error.to_string())?
                            .into_os_string()
                            .into_string()
                            .map_err(|_| "目录名称无法转换为文本。".to_string())
                    })
                    .collect::<Result<Vec<_>, String>>()
            })
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let parsed = tauri::Url::parse(&url).map_err(|_| "链接无效。")?;
    if !["http", "https"].contains(&parsed.scheme()) || parsed.host_str().is_none() {
        return Err("仅支持打开 HTTP 和 HTTPS 链接。".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn window_appearance(app: tauri::AppHandle, blur: bool) -> Result<(), String> {
    #[cfg(any(windows, target_os = "macos"))]
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    let window = app.get_webview_window("main").ok_or("找不到应用窗口。")?;
    if blur {
        #[cfg(target_os = "macos")]
        let effect = Effect::Sidebar;
        #[cfg(windows)]
        let effect = Effect::Acrylic;
        #[cfg(not(any(windows, target_os = "macos")))]
        return Err("当前平台不支持背景模糊。".into());
        #[cfg(any(windows, target_os = "macos"))]
        window
            .set_effects(
                EffectsBuilder::new()
                    .effect(effect)
                    .state(EffectState::Active)
                    .build(),
            )
            .map_err(|e| e.to_string())?;
    } else {
        window.set_effects(None).map_err(|e| e.to_string())?;
    }
    Ok(())
}

const AUTOSTART_ARGUMENT: &str = "--autostart";

fn starts_in_background(arguments: impl IntoIterator<Item = impl AsRef<std::ffi::OsStr>>) -> bool {
    let arguments: Vec<_> = arguments
        .into_iter()
        .map(|argument| argument.as_ref().to_owned())
        .collect();
    arguments
        .iter()
        .any(|argument| argument == AUTOSTART_ARGUMENT)
        && !arguments
            .iter()
            .any(|argument| argument.to_string_lossy().starts_with("uterm://"))
}

fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let mode = arguments.next();
    if mode.as_deref() == Some(std::ffi::OsStr::new("--control")) {
        #[cfg(windows)]
        {
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn AttachConsole(pid: u32) -> i32;
            }
            unsafe {
                AttachConsole(u32::MAX);
            }
        }
        match control::cli(
            arguments
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect(),
        ) {
            Ok(value) => println!("{value}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    if mode.as_deref() == Some(std::ffi::OsStr::new("--agent-report")) {
        let result = utermd_local::daemon::report_from_environment(
            arguments
                .next()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        );
        if let Err(error) = result {
            eprintln!("Agent report failed: {error:#}");
        }
        println!("{{}}");
        return;
    }
    if mode.as_deref() == Some(std::ffi::OsStr::new("--local-daemon")) {
        let result = arguments
            .next()
            .ok_or_else(|| "Missing daemon directory".to_string())
            .and_then(|directory| {
                utermd_local::daemon::serve(std::path::Path::new(&directory))
                    .map_err(|error| format!("{error:#}"))
            });
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let mut context = tauri::generate_context!();
    if starts_in_background(std::env::args_os().skip(1)) {
        for window in &mut context.config_mut().app.windows {
            if window.label == "main" {
                window.visible = false;
                window.focus = false;
            }
        }
    }
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, arguments, _| {
            if let Some(state) = app.try_state::<std::sync::Arc<control::Control>>() {
                for value in arguments
                    .iter()
                    .filter(|value| value.starts_with("uterm://"))
                {
                    if let Err(error) = state.open_link(value) {
                        eprintln!("Session link: {error}");
                    }
                }
            }
            if !starts_in_background(arguments.iter().skip(1)) {
                if let Err(error) = show_main_window(app) {
                    eprintln!("Show desktop: {error}");
                }
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(updates::Updates::default())
        .manage(taskbar::Taskbar::default())
        .setup(|app| {
            use tauri_plugin_deep_link::DeepLinkExt;
            #[cfg(windows)]
            {
                let window = app.get_webview_window("main").ok_or("找不到应用窗口。")?;
                // The native frame follows Windows' system theme unless it is set here.
                // Keep it dark so a light system title bar does not sit above uTerm.
                window.set_theme(Some(tauri::Theme::Dark))?;
                // Disable WebView2 menus in every frame, including sandboxed HTML previews.
                // 禁用所有框架中的 WebView2 菜单，包括沙盒 HTML 预览。
                window.with_webview(|webview| unsafe {
                    let result = webview
                        .controller()
                        .CoreWebView2()
                        .and_then(|webview| webview.Settings())
                        .and_then(|settings| settings.SetAreDefaultContextMenusEnabled(false));
                    if let Err(error) = result {
                        eprintln!("Disable browser context menus: {error}");
                    }
                })?;
            }
            if app.config().plugins.0.contains_key("updater") {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            #[cfg(any(windows, target_os = "macos"))]
            taskbar::install(app)?;
            let state = control::Control::start(app.handle()).map_err(std::io::Error::other)?;
            app.manage(state.clone());
            #[cfg(any(windows, target_os = "linux"))]
            app.deep_link().register_all()?;
            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    if let Err(error) = state.open_link(url.as_str()) {
                        eprintln!("Session link: {error}");
                    }
                }
            }
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Err(error) = state.open_link(url.as_str()) {
                        eprintln!("Session link: {error}");
                    }
                }
            });
            Ok(())
        })
        .menu(files::menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "editor-quit" {
                app.exit(0);
            }
            if event.id().as_ref() == "desktop-window-close" {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.hide() {
                        eprintln!("Hide window: {error}");
                    }
                }
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin({
            let builder = tauri_plugin_autostart::Builder::new()
                .app_name(if cfg!(debug_assertions) {
                    "uTerm-dev"
                } else {
                    "uTerm"
                })
                .args([AUTOSTART_ARGUMENT]);
            #[cfg(target_os = "macos")]
            let builder =
                builder.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
            builder.build()
        })
        .manage(std::sync::Arc::new(sessions::Sessions::default()))
        .manage(files::EditorGuard::default())
        .invoke_handler(tauri::generate_handler![
            autostart_configure,
            runtime_info,
            updates::update_status,
            updates::update_check,
            updates::update_download,
            updates::update_install,
            select_project_directory,
            projects::directory_tools,
            projects::directory_open,
            window_appearance,
            taskbar::taskbar_sync,
            control::control_status,
            control::control_configure,
            control::control_poll,
            control::control_reply,
            control::control_focus,
            control::control_install,
            sessions::control_session,
            sessions::local_session_list,
            open_external,
            agent_install::install_agent,
            files::files_list,
            files::file_mutate,
            files::file_copy,
            files::file_reveal,
            files::file_read,
            files::file_save,
            files::files_search,
            files::editor_guard,
            files::editor_exit,
            github::github_repositories,
            github::github_read,
            github::github_prepare_pr,
            github::github_create_pr,
            git::git_branch,
            git::git_branches,
            git::git_remote_branches,
            git::git_switch_remote_branch,
            git::git_branch_action,
            git::git_switch_branch,
            git::git_snapshot,
            git::git_diff,
            git::git_history,
            git::git_files,
            agents::agent_definitions,
            agents::save_agents,
            agents::agent_hooks,
            agents::agent_usage,
            sessions::start_session,
            sessions::session_action,
            sessions::project_directory,
            projects::project_worktrees,
            projects::create_worktree,
            projects::delete_worktree
        ])
        .build(context);
    match result {
        Ok(app) => app.run(|handle, event| {
            match &event {
                tauri::RunEvent::WindowEvent {
                    event: tauri::WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    api.prevent_close();
                    if let Some(window) = handle.get_webview_window("main") {
                        if let Err(error) = window.hide() {
                            eprintln!("Hide window: {error}");
                        }
                    }
                }
                tauri::RunEvent::ExitRequested { api, .. }
                    if handle
                        .state::<files::EditorGuard>()
                        .0
                        .load(std::sync::atomic::Ordering::SeqCst) =>
                {
                    api.prevent_exit();
                    if let Err(error) = handle.emit("editor-close-request", ()) {
                        eprintln!("Editor close request: {error}");
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } if !has_visible_windows => {
                    if let Err(error) = show_main_window(handle) {
                        eprintln!("Show desktop: {error}");
                    }
                }
                _ => {}
            }
            if matches!(event, tauri::RunEvent::Exit) {
                handle
                    .state::<std::sync::Arc<sessions::Sessions>>()
                    .detach();
            }
        }),
        Err(error) => {
            eprintln!("uTerm could not start: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod startup_tests {
    use super::starts_in_background;

    #[test]
    fn login_stays_hidden_but_manual_and_session_links_open() {
        assert!(starts_in_background(["--autostart"]));
        assert!(!starts_in_background(Vec::<String>::new()));
        assert!(!starts_in_background(["--other"]));
        assert!(!starts_in_background(["--autostart-extra"]));
        assert!(!starts_in_background([
            "--autostart",
            "uterm://session/test"
        ]));
        assert!(!starts_in_background([
            "uterm://session/test",
            "--autostart"
        ]));
    }
}
