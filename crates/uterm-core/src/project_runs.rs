use anyhow::{bail, Result};
use std::path::Path;
use utermd_local::daemon::{Client, Operation, Reply, TaskSession};

pub fn read(host_root: &Path) -> Result<Vec<TaskSession>> {
    // Discovery must not launch a host or require the project directory to still exist.
    // 查询不得启动宿主，也不要求项目目录仍然存在。
    if !host_root.join("endpoint.json").exists() {
        return Ok(vec![]);
    }
    let client = Client::connect(host_root)?;
    client.require_task_support()?;
    let Reply::Tasks(tasks) = client.request(Operation::TaskSnapshot)? else {
        bail!("Invalid project run summary");
    };
    Ok(tasks)
}

pub fn running(tasks: Vec<TaskSession>) -> Vec<TaskSession> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use utermd_local::{daemon::SessionSpec, tasks::TaskInfo};

    #[test]
    fn missing_host_is_read_only_and_broken_endpoint_is_an_error() {
        let root = tempfile::tempdir().unwrap();
        assert!(read(root.path()).unwrap().is_empty());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        std::fs::write(root.path().join("endpoint.json"), "invalid endpoint").unwrap();
        assert!(read(root.path()).is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn public_core_route_discovers_without_starting_a_host_and_preserves_errors() {
        let root = tempfile::tempdir().unwrap();
        let core = crate::Core::open(root.path().join("shared-state-v1")).unwrap();
        let request = |params| {
            core.execute(&serde_json::to_vec(&serde_json::json!({
                "version": 1, "id": "project-runs-route", "method": "project.tasks", "params": params,
            })).unwrap())
        };
        for params in [serde_json::Value::Null, serde_json::json!({})] {
            let response = request(params);
            assert!(response.error.is_none(), "{:?}", response.error);
            assert_eq!(response.result, Some(serde_json::json!([])));
        }
        let host = root.path().join("local-daemon-v1");
        assert!(!host.exists());
        for params in [
            serde_json::json!({"directory": "/unowned"}),
            serde_json::json!([]),
            serde_json::json!(1),
        ] {
            assert_eq!(request(params).error.unwrap().code, "INVALID_PARAMS");
        }
        std::fs::create_dir(&host).unwrap();
        std::fs::write(host.join("endpoint.json"), "invalid endpoint").unwrap();
        assert_eq!(
            request(serde_json::Value::Null).error.unwrap().code,
            "PROJECT_RUNS_FAILED"
        );
        assert_eq!(std::fs::read_dir(host).unwrap().count(), 1);
    }

    #[test]
    fn keeps_live_java_and_python_tasks_with_exact_identity_and_removed_roots() {
        let task = |id: &str, action: &str, running: bool| TaskSession {
            spec: SessionSpec {
                id: id.into(),
                directory: "/removed 中文 & %/".into(),
                shell: "default".into(),
                agent: None,
                ssh: None,
            },
            generation: format!("generation-{id}"),
            task: TaskInfo {
                root: "/removed 中文 & %/".into(),
                name: "literal 中文 & %".into(),
                action: action.into(),
                created: 1,
            },
            running,
            code: None,
        };
        let values = running(vec![
            task("java", "run", true),
            task("python", "python:run", true),
            task("web", "python:run|http://127.0.0.1:8000", true),
            task("build", "build", true),
            task("other", "python:other", true),
            task("exited", "run", false),
        ]);
        assert_eq!(
            values
                .iter()
                .map(|value| value.spec.id.as_str())
                .collect::<Vec<_>>(),
            ["java", "python", "web"]
        );
        assert_eq!(values[2].generation, "generation-web");
        assert_eq!(values[2].task.root, Path::new("/removed 中文 & %/"));
    }
}
