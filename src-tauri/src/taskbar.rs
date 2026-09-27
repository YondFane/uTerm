use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

const TRAY_ID: &str = "uterm-tasks";
const OPEN_ID: &str = "taskbar-open";
const QUIT_ID: &str = "taskbar-quit";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum TaskState {
    Working,
    Waiting,
    Done,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AggregateStatus {
    Idle,
    Working,
    Done,
    Attention,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Labels {
    open: String,
    empty: String,
    quit: String,
    idle: String,
    working: String,
    needs_you: String,
    done: String,
    exited: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct Task {
    id: String,
    title: String,
    state: TaskState,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct Group {
    title: String,
    tasks: Vec<Task>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    status: AggregateStatus,
    labels: Labels,
    groups: Vec<Group>,
}

#[derive(Default)]
pub struct Taskbar {
    snapshot: Mutex<Option<Snapshot>>,
    sessions: Mutex<HashMap<String, String>>,
}

fn default_snapshot() -> Snapshot {
    Snapshot {
        status: AggregateStatus::Idle,
        labels: Labels {
            open: "打开 uTerm".into(),
            empty: "全部处理完毕".into(),
            quit: "退出 uTerm".into(),
            idle: "空闲".into(),
            working: "工作中".into(),
            needs_you: "需要你".into(),
            done: "已完成".into(),
            exited: "已退出".into(),
        },
        groups: vec![],
    }
}

fn aggregate(groups: &[Group]) -> AggregateStatus {
    let states = groups
        .iter()
        .flat_map(|group| group.tasks.iter().map(|task| task.state))
        .collect::<Vec<_>>();
    if states
        .iter()
        .any(|state| matches!(state, TaskState::Waiting | TaskState::Error))
    {
        AggregateStatus::Attention
    } else if states.contains(&TaskState::Done) {
        AggregateStatus::Done
    } else if states.contains(&TaskState::Working) {
        AggregateStatus::Working
    } else {
        AggregateStatus::Idle
    }
}

fn valid_text(value: &str, maximum: usize) -> bool {
    let length = value.chars().count();
    length > 0 && length <= maximum && !value.contains('\0')
}

fn validate(snapshot: &Snapshot) -> Result<(), String> {
    if snapshot.groups.len() > 100
        || ![
            &snapshot.labels.open,
            &snapshot.labels.empty,
            &snapshot.labels.quit,
            &snapshot.labels.idle,
            &snapshot.labels.working,
            &snapshot.labels.needs_you,
            &snapshot.labels.done,
            &snapshot.labels.exited,
        ]
        .iter()
        .all(|value| valid_text(value, 100))
    {
        return Err("任务栏内容无效。".into());
    }
    let mut identifiers = HashSet::new();
    let mut count = 0;
    for group in &snapshot.groups {
        if !valid_text(&group.title, 200) || group.tasks.is_empty() {
            return Err("任务栏分组无效。".into());
        }
        count += group.tasks.len();
        for task in &group.tasks {
            if !valid_text(&task.id, 200)
                || !valid_text(&task.title, 200)
                || !identifiers.insert(&task.id)
            {
                return Err("任务栏会话无效。".into());
            }
        }
    }
    if count > 1000 || snapshot.status != aggregate(&snapshot.groups) {
        return Err("任务栏状态无效。".into());
    }
    Ok(())
}

fn menu_text(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if matches!(character, '\r' | '\n' | '\t') {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .replace('&', "&&")
}

fn state_label<'a>(state: TaskState, labels: &'a Labels) -> &'a str {
    match state {
        TaskState::Working => &labels.working,
        TaskState::Waiting => &labels.needs_you,
        TaskState::Done => &labels.done,
        TaskState::Error => &labels.exited,
    }
}

fn menu(
    app: &tauri::AppHandle,
    snapshot: &Snapshot,
) -> tauri::Result<(Menu<tauri::Wry>, HashMap<String, String>)> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        OPEN_ID,
        menu_text(&snapshot.labels.open),
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let mut sessions = HashMap::new();
    let mut item_index = 0;
    if snapshot.groups.is_empty() {
        menu.append(&MenuItem::with_id(
            app,
            "taskbar-empty",
            menu_text(&snapshot.labels.empty),
            false,
            None::<&str>,
        )?)?;
    } else {
        for (group_index, group) in snapshot.groups.iter().enumerate() {
            if group_index > 0 {
                menu.append(&PredefinedMenuItem::separator(app)?)?;
            }
            menu.append(&MenuItem::with_id(
                app,
                format!("taskbar-group-{group_index}"),
                menu_text(&group.title),
                false,
                None::<&str>,
            )?)?;
            for task in &group.tasks {
                let item_id = format!("taskbar-task-{item_index}");
                item_index += 1;
                sessions.insert(item_id.clone(), task.id.clone());
                menu.append(&MenuItem::with_id(
                    app,
                    item_id,
                    menu_text(&format!(
                        "{}: {}",
                        state_label(task.state, &snapshot.labels),
                        task.title
                    )),
                    true,
                    None::<&str>,
                )?)?;
            }
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        QUIT_ID,
        menu_text(&snapshot.labels.quit),
        true,
        None::<&str>,
    )?)?;
    Ok((menu, sessions))
}

fn icon(status: AggregateStatus) -> Image<'static> {
    const SIDE: usize = 32;
    let mut pixels = vec![0; SIDE * SIDE * 4];
    let paint = |pixels: &mut [u8], x: usize, y: usize, color: [u8; 4]| {
        let offset = (y * SIDE + x) * 4;
        pixels[offset..offset + 4].copy_from_slice(&color);
    };
    // Match the red U in icons/icon.svg while leaving room for status overlays.
    // 与 icons/icon.svg 的红色 U 保持一致，并为任务状态标记留出空间。
    let brand = [239, 43, 45, 255];
    for row in 0..4 {
        for column in 0..4 {
            let filled = if row < 3 {
                column == 0 || column == 3
            } else {
                column == 1 || column == 2
            };
            if !filled {
                continue;
            }
            for y in (4 + row * 6)..(9 + row * 6) {
                for x in (4 + column * 6)..(9 + column * 6) {
                    paint(&mut pixels, x, y, brand);
                }
            }
        }
    }
    if status == AggregateStatus::Done {
        let frame = [106, 224, 145, 255];
        for edge in 1..3 {
            for coordinate in edge..(SIDE - edge) {
                paint(&mut pixels, coordinate, edge, frame);
                paint(&mut pixels, coordinate, SIDE - edge - 1, frame);
                paint(&mut pixels, edge, coordinate, frame);
                paint(&mut pixels, SIDE - edge - 1, coordinate, frame);
            }
        }
    }
    let badge = match status {
        AggregateStatus::Idle => None,
        AggregateStatus::Working => Some([134, 184, 231, 255]),
        AggregateStatus::Done => Some([106, 199, 137, 255]),
        AggregateStatus::Attention => Some([232, 180, 107, 255]),
    };
    if let Some(color) = badge {
        for y in 0..13 {
            for x in 19..32 {
                let distance = (x as isize - 25).pow(2) + (y as isize - 6).pow(2);
                if distance <= 42 {
                    paint(&mut pixels, x, y, [0, 0, 0, 0]);
                }
                if distance <= 25 {
                    paint(&mut pixels, x, y, color);
                }
            }
        }
    }
    Image::new_owned(pixels, SIDE as u32, SIDE as u32)
}

fn tooltip(snapshot: &Snapshot) -> String {
    let status = match snapshot.status {
        AggregateStatus::Idle => &snapshot.labels.idle,
        AggregateStatus::Working => &snapshot.labels.working,
        AggregateStatus::Done => &snapshot.labels.done,
        AggregateStatus::Attention => &snapshot.labels.needs_you,
    };
    format!("uTerm — {status}")
}

fn opens_window_on_tray_click(button: MouseButton) -> bool {
    button == MouseButton::Left
}

fn handle_menu(app: &tauri::AppHandle, item_id: &str) {
    if item_id == OPEN_ID {
        if let Err(error) = crate::show_main_window(app) {
            eprintln!("Show desktop: {error}");
        }
        return;
    }
    if item_id == QUIT_ID {
        app.exit(0);
        return;
    }
    let session = app
        .state::<Taskbar>()
        .sessions
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(item_id).cloned());
    if let Some(session) = session {
        if let Err(error) = crate::show_main_window(app) {
            eprintln!("Show desktop: {error}");
        }
        if let Err(error) = app.emit("taskbar-session-selected", session) {
            eprintln!("Select taskbar session: {error}");
        }
    }
}

pub fn install(app: &mut tauri::App) -> tauri::Result<()> {
    let snapshot = default_snapshot();
    let (menu, _) = menu(app.handle(), &snapshot)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon(icon(snapshot.status))
        .tooltip(tooltip(&snapshot))
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click { button, .. } if opens_window_on_tray_click(button)
            ) {
                if let Err(error) = crate::show_main_window(tray.app_handle()) {
                    eprintln!("Show desktop: {error}");
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
pub fn taskbar_sync(
    app: tauri::AppHandle,
    state: tauri::State<'_, Taskbar>,
    snapshot: Snapshot,
) -> Result<(), String> {
    validate(&snapshot)?;
    {
        let current = state.snapshot.lock().map_err(|error| error.to_string())?;
        if current.as_ref() == Some(&snapshot) {
            return Ok(());
        }
    }
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        *state.snapshot.lock().map_err(|error| error.to_string())? = Some(snapshot);
        return Ok(());
    };
    let (menu, sessions) = menu(&app, &snapshot).map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu))
        .map_err(|error| error.to_string())?;
    tray.set_icon(Some(icon(snapshot.status)))
        .map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(tooltip(&snapshot)))
        .map_err(|error| error.to_string())?;
    *state.sessions.lock().map_err(|error| error.to_string())? = sessions;
    *state.snapshot.lock().map_err(|error| error.to_string())? = Some(snapshot);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels() -> Labels {
        default_snapshot().labels
    }

    fn task(id: &str, title: &str, state: TaskState) -> Task {
        Task {
            id: id.into(),
            title: title.into(),
            state,
        }
    }

    #[test]
    fn aggregate_prioritizes_attention_then_done_then_working() {
        let group = |tasks| Group {
            title: "Project".into(),
            tasks,
        };
        assert_eq!(aggregate(&[]), AggregateStatus::Idle);
        assert_eq!(
            aggregate(&[group(vec![task("done", "Done", TaskState::Done)])]),
            AggregateStatus::Done
        );
        assert_eq!(
            aggregate(&[group(vec![
                task("done", "Done", TaskState::Done),
                task("working", "Working", TaskState::Working),
            ])]),
            AggregateStatus::Done
        );
        assert_eq!(
            aggregate(&[group(vec![
                task("working", "Working", TaskState::Working),
                task("waiting", "Waiting", TaskState::Waiting),
            ])]),
            AggregateStatus::Attention
        );
    }

    #[test]
    fn validation_rejects_duplicates_limits_and_incorrect_aggregate() {
        let valid = Snapshot {
            status: AggregateStatus::Done,
            labels: labels(),
            groups: vec![Group {
                title: "Project".into(),
                tasks: vec![task("id", "Task", TaskState::Done)],
            }],
        };
        assert!(validate(&valid).is_ok());
        let mut duplicate = valid.clone();
        duplicate.groups[0]
            .tasks
            .push(task("id", "Another", TaskState::Done));
        assert!(validate(&duplicate).is_err());
        let mut incorrect = valid.clone();
        incorrect.status = AggregateStatus::Working;
        assert!(validate(&incorrect).is_err());
        let mut oversized = valid;
        oversized.groups[0].tasks[0].title = "x".repeat(201);
        assert!(validate(&oversized).is_err());
    }

    #[test]
    fn menu_identifiers_do_not_include_user_text() {
        let snapshot = Snapshot {
            status: AggregateStatus::Attention,
            labels: labels(),
            groups: vec![Group {
                title: "Project & tools".into(),
                tasks: vec![
                    task("same/title", "Same & title", TaskState::Waiting),
                    task("same?title", "Same & title", TaskState::Error),
                ],
            }],
        };
        assert!(validate(&snapshot).is_ok());
        assert_eq!(menu_text("A&B\nC"), "A&&B C");
        let identifiers = snapshot
            .groups
            .iter()
            .flat_map(|group| group.tasks.iter())
            .enumerate()
            .map(|(index, task)| (format!("taskbar-task-{index}"), task.id.clone()))
            .collect::<HashMap<_, _>>();
        assert_eq!(identifiers["taskbar-task-0"], "same/title");
        assert_eq!(identifiers["taskbar-task-1"], "same?title");
    }

    #[test]
    fn only_primary_tray_clicks_open_the_window() {
        assert!(opens_window_on_tray_click(MouseButton::Left));
        assert!(!opens_window_on_tray_click(MouseButton::Right));
        assert!(!opens_window_on_tray_click(MouseButton::Middle));
    }
}
