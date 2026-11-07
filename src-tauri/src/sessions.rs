use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};
use tauri::{
    ipc::{Channel, Response},
    Manager,
};
use utermd_local::daemon::{Client, Operation, Reply, SessionSnapshot, SessionSpec, TaskSession};

use uterm_core::terminal::Links;
#[derive(Default)]
pub struct Sessions {
    broker: OnceLock<uterm_core::host::HostBroker>,
    links: Arc<Links>,
}
pub(crate) fn local_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("local-daemon-v1"))
        .map_err(|error| error.to_string())
}

pub(crate) fn local_client(app: &tauri::AppHandle, state: &Sessions) -> Result<Client, String> {
    if state.broker.get().is_none() {
        let broker = uterm_core::host::HostBroker::new(
            local_root(app)?,
            std::env::current_exe().map_err(|e| e.to_string())?,
        );
        let _ = state.broker.set(broker);
    }
    state
        .broker
        .get()
        .ok_or("Host is not initialized")?
        .client()
}

impl Sessions {
    pub fn detach(&self) {
        self.links.detach();
    }
    pub fn release_for_update(&self) -> Result<(), String> {
        self.links.release_inputs()
    }
}

#[derive(Deserialize)]
pub struct StartRequest {
    #[serde(default)]
    existing_only: bool,
    id: String,
    attachment: String,
    directory: String,
    shell: String,
    agent: Option<String>,
    ssh: Option<utermd_local::ssh::SshTarget>,
    #[serde(default)]
    create: bool,
    rows: u16,
    cols: u16,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct ProjectRunSummary {
    java: usize,
    python: usize,
    java_roots: Vec<std::path::PathBuf>,
    python_roots: Vec<std::path::PathBuf>,
}

fn summarize_project_runs(tasks: Vec<TaskSession>) -> ProjectRunSummary {
    let mut java = HashSet::new();
    let mut python = HashSet::new();
    for task in tasks.into_iter().filter(|task| task.running) {
        if task.task.action == "run" {
            java.insert(task.task.root);
        } else if task.task.action == "python:run" || task.task.action.starts_with("python:run|") {
            python.insert(task.task.root);
        }
    }
    let mut java_roots: Vec<_> = java.into_iter().collect();
    let mut python_roots: Vec<_> = python.into_iter().collect();
    java_roots.sort();
    python_roots.sort();
    ProjectRunSummary {
        java: java_roots.len(),
        python: python_roots.len(),
        java_roots,
        python_roots,
    }
}

fn read_project_run_summary(root: &std::path::Path) -> Result<ProjectRunSummary, String> {
    read_project_run_tasks(root).map(summarize_project_runs)
}

fn read_project_run_tasks(root: &std::path::Path) -> Result<Vec<TaskSession>, String> {
    // Status reads must neither launch a host nor depend on a still-existing project directory.
    // 状态读取既不能启动宿主，也不能依赖项目目录仍然存在。
    if !root.join("endpoint.json").exists() {
        return Ok(vec![]);
    }
    let client = Client::connect(root).map_err(|error| error.to_string())?;
    client
        .require_task_support()
        .map_err(|error| error.to_string())?;
    match client
        .request(Operation::TaskSnapshot)
        .map_err(|error| error.to_string())?
    {
        Reply::Tasks(tasks) => Ok(tasks),
        _ => Err("Invalid project run summary".into()),
    }
}

fn running_project_tasks(tasks: Vec<TaskSession>) -> Vec<TaskSession> {
    tasks
        .into_iter()
        .filter(|task| {
            task.running
                && (task.task.action == "run"
                    || task.task.action == "python:run"
                    || task.task.action.starts_with("python:run|"))
        })
        .collect()
}

#[tauri::command]
pub async fn project_run_list(app: tauri::AppHandle) -> Result<Vec<TaskSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_project_run_tasks(&local_root(&app)?).map(running_project_tasks)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_run_summary(app: tauri::AppHandle) -> Result<ProjectRunSummary, String> {
    tauri::async_runtime::spawn_blocking(move || read_project_run_summary(&local_root(&app)?))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_session_list(app: tauri::AppHandle) -> Result<SessionSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = local_root(&app)?;
        // Discovery must not start an otherwise unused host or replace a live one.
        // 会话发现不得启动未使用的宿主，也不得替换正在运行的宿主。
        if !root.join("endpoint.json").exists() {
            return Ok(SessionSnapshot::default());
        }
        let client = Client::connect(&root).map_err(|error| error.to_string())?;
        match client
            .request(Operation::SessionSnapshot)
            .map_err(|error| error.to_string())?
        {
            Reply::SessionSnapshot(snapshot) => Ok(snapshot),
            _ => Err("Invalid local session list".into()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn ssh_session_list(app: tauri::AppHandle) -> Result<SessionSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = local_root(&app)?;
        if !root.join("endpoint.json").exists() {
            return Ok(SessionSnapshot::default());
        }
        let client = Client::connect(&root).map_err(|error| error.to_string())?;
        if let Err(error) = client.require_ssh_support() {
            if error.to_string() == "SSH_HOST_UPGRADE_REQUIRED" {
                return Ok(SessionSnapshot::default());
            }
            return Err(error.to_string());
        }
        match client
            .request(Operation::SshSessionSnapshot)
            .map_err(|error| error.to_string())?
        {
            Reply::SshSessionSnapshot(snapshot) => Ok(snapshot),
            _ => Err("Invalid SSH session list".into()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn start_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Sessions>>,
    request: StartRequest,
    events: Channel<Response>,
) -> Result<(), String> {
    let StartRequest {
        existing_only,
        id,
        attachment,
        directory,
        shell,
        agent,
        ssh,
        create,
        rows,
        cols,
    } = request;
    let prepared = if create {
        if let Some(target) = &ssh {
            Some(
                crate::ssh_auth::prepare(&app, target)
                    .await
                    .map_err(|error| error.to_string())?,
            )
        } else {
            None
        }
    } else {
        None
    };
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let client = local_client(&app, &state)?;
        if agent.is_some() {
            client
                .require_agent_support()
                .map_err(|error| error.to_string())?;
        }
        let is_ssh = ssh.is_some();
        if ssh
            .as_ref()
            .is_some_and(|target| target.jump_host.is_some())
        {
            client
                .require_ssh_jump_support()
                .map_err(|error| error.to_string())?;
        }
        if is_ssh {
            client
                .require_ssh_support()
                .map_err(|error| error.to_string())?;
            if ssh.as_ref().is_some_and(|target| target.mode.is_some()) {
                client
                    .require_ssh_config_support()
                    .map_err(|error| error.to_string())?;
            }
        }
        let spec = SessionSpec {
            id: id.clone(),
            directory: directory.into(),
            shell,
            agent,
            ssh,
        };
        let operation = if existing_only {
            client
                .require_task_support()
                .map_err(|error| error.to_string())?;
            Operation::Attach {
                id: id.clone(),
                rows,
                cols,
            }
        } else if let Some(prepared) = prepared {
            client
                .require_ssh_config_support()
                .map_err(|error| error.to_string())?;
            Operation::OpenSshConfigured {
                spec,
                rows,
                cols,
                resolved: prepared.resolved().map_err(|error| error.to_string())?,
                askpass: prepared.askpass,
            }
        } else if is_ssh {
            Operation::OpenSsh {
                spec,
                rows,
                cols,
                create,
            }
        } else {
            Operation::Open { spec, rows, cols }
        };
        state.links.open(
            client,
            operation,
            id,
            attachment,
            rows,
            cols,
            Arc::new(move |_, _, frame| {
                events
                    .send(Response::new(uterm_core::terminal::encode_frame(
                        &frame, None,
                    )))
                    .map_err(|e| e.to_string())
            }),
        )?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_action(
    state: tauri::State<'_, Arc<Sessions>>,
    id: String,
    action: String,
    data: Option<Vec<u8>>,
    rows: Option<u16>,
    cols: Option<u16>,
    sequence: Option<serde_json::Value>,
) -> Result<(), String> {
    let sequence = sequence
        .as_ref()
        .map(uterm_core::terminal::parse_sequence)
        .transpose()?;
    if action == "ack" && sequence.is_none() {
        return Err("Acknowledgement requires a sequence".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.links.action(&id, &action, data, rows, cols, sequence)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_directory(directory: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || uterm_core::host::project_directory(directory))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn control_session(
    state: tauri::State<'_, Arc<Sessions>>,
    id: String,
    action: String,
    text: Option<String>,
    activity_event: Option<String>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let link = state.links.find(&id)?;
        let operation = match action.as_str() {
            "send" => {
                let data = text.ok_or("缺少输入文本。")?.into_bytes();
                if data.len() > 65536 {
                    return Err("输入超过 64 KB。".into());
                }
                Operation::Write {
                    id,
                    generation: link.generation.clone(),
                    data,
                }
            }
            "close" => Operation::Close {
                id,
                generation: link.generation.clone(),
            },
            "acknowledge" if activity_event.is_some() => Operation::AcknowledgeAgentEvent {
                id,
                generation: link.generation.clone(),
                event: activity_event.unwrap(),
            },
            "acknowledge" => Operation::Report {
                id,
                generation: link.generation.clone(),
                state: "idle".into(),
            },
            _ => return Err("未知会话操作。".into()),
        };
        link.client.request(operation).map_err(|e| e.to_string())?;
        if action == "close" {
            link.stop();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod update_tests {
    use super::*;
    use uterm_core::host::stage_host;
    #[test]
    fn project_runs_count_live_language_roots_and_exclude_builds_and_history() {
        let task = |root: &str, action: &str, running: bool| TaskSession {
            spec: SessionSpec {
                id: uuid::Uuid::new_v4().to_string(),
                directory: root.into(),
                shell: "default".into(),
                agent: None,
                ssh: None,
            },
            generation: "generation".into(),
            task: utermd_local::tasks::TaskInfo {
                root: root.into(),
                name: "project".into(),
                action: action.into(),
                created: 0,
            },
            running,
            code: None,
        };
        assert_eq!(
            summarize_project_runs(vec![
                task("/java", "run", true),
                task("/java", "run", true),
                task("/java-worktree", "run", true),
                task("/python", "python:run", true),
                task("/python-web", "python:run|http://127.0.0.1:8000", true),
                task("/python-web", "python:run|http://127.0.0.1:8000", true),
                task("/build", "build", true),
                task("/test", "test", true),
                task("/install", "install", true),
                task("/unknown", "python:other", true),
                task("/old-java", "run", false),
                task("/old-python", "python:run", false),
            ]),
            ProjectRunSummary {
                java: 2,
                python: 2,
                java_roots: vec!["/java".into(), "/java-worktree".into()],
                python_roots: vec!["/python".into(), "/python-web".into()],
            }
        );
        assert_eq!(summarize_project_runs(vec![]), ProjectRunSummary::default());
        let live = running_project_tasks(vec![
            task("/java", "run", true),
            task("/python", "python:run", true),
            task("/web", "python:run|http://127.0.0.1:8000", true),
            task("/build", "build", true),
            task("/unknown", "python:other", true),
            task("/old", "run", false),
        ]);
        assert_eq!(live.len(), 3);
        assert_eq!(live[0].task.root, std::path::PathBuf::from("/java"));
        assert_eq!(live[2].task.action, "python:run|http://127.0.0.1:8000");
    }

    #[test]
    fn project_run_discovery_without_a_host_does_not_create_one() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            read_project_run_summary(root.path()).unwrap(),
            ProjectRunSummary::default()
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        std::fs::write(root.path().join("endpoint.json"), "broken").unwrap();
        assert!(read_project_run_summary(root.path()).is_err());
    }

    #[test]
    fn host_copies_survive_app_replacement_and_detect_corruption() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("app");
        let root = directory.path().join("state");
        std::fs::write(&source, b"old executable").unwrap();
        let old = stage_host(&root, &source).unwrap();
        assert_eq!(stage_host(&root, &source).unwrap(), old);
        std::fs::write(&source, b"new executable").unwrap();
        let new = stage_host(&root, &source).unwrap();
        assert_ne!(new, old);
        assert_eq!(std::fs::read(&old).unwrap(), b"old executable");
        std::fs::write(&new, b"corrupt").unwrap();
        assert!(stage_host(&root, &source).is_err());
    }
}
