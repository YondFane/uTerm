use crate::{session_state, state, string, Core, CoreError, Result};
use serde_json::{json, Value};
use utermd_local::control::Request;

pub(crate) fn execute(core: &Core, request: Request, options: &Value) -> Result<Value> {
    let expected = string(options, "expectedRevision")?;
    let snapshot = core.store.read()?;
    if snapshot.revision != expected {
        return Err(CoreError::new(
            "CONFLICT",
            "Snapshot changed; reload before another control action",
        ));
    }
    if request.method == "sessions.new" {
        let directory = crate::host::project_directory(string(&request.params, "directory")?)
            .map_err(|e| CoreError::new("INVALID_PATH", e))?;
        let agent = request.params.get("agent").cloned().unwrap_or(Value::Null);
        if let Some(agent) = agent.as_str() {
            utermd_local::agents::resolve(core.data_root()?, agent)
                .map_err(|e| CoreError::new("AGENT_UNAVAILABLE", e.to_string()))?;
        } else if !agent.is_null() {
            return Err(CoreError::new("INVALID_PARAMS", "Agent must be a string"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let saved = core.store.update(&expected, |document| {
            let project = document.workspace["projects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|project| {
                    project["directory"]
                        .as_str()
                        .and_then(|path| std::fs::canonicalize(path).ok())
                        == Some(std::path::PathBuf::from(&directory))
                })
                .cloned();
            let project_id = project
                .as_ref()
                .map(|p| p["id"].clone())
                .unwrap_or(Value::Null);
            if let Some(project) = project {
                state::switch_workspace(
                    &mut document.workspace,
                    project["workspaceId"].as_str().unwrap(),
                );
            }
            // CLI directory selection refers to the project root, not a selected Worktree.
            // CLI 目录选择指向项目根目录，不继承当前选中的 Worktree。
            document.workspace["selectedWorktree"] = Value::Null;
            session_state::transition(
                &mut document.workspace,
                &document.settings,
                "session.create",
                &json!({
                    "id":id,"name":agent.as_str().unwrap_or("Terminal"),"directory":directory,
                    "agent":agent,"projectId":project_id
                }),
            )
        })?;
        return Ok(
            json!({"revision":saved.revision,"result":{"id":id,"link":format!("uterm://session/{id}"),"status":"created"}}),
        );
    }
    let id = if request.method == "open" {
        utermd_local::control::valid_link(&string(&request.params, "url")?)
            .map_err(|e| CoreError::new("INVALID_PARAMS", e))?
    } else {
        string(&request.params, "id")?
    };
    if !session_state::entries(&snapshot.document.workspace)
        .iter()
        .any(|entry| entry.session["id"] == id)
    {
        return Err(CoreError::new(
            "SESSION_MISSING",
            "The session does not exist in this installation",
        ));
    }
    match request.method.as_str() {
        "sessions.focus" | "open" => {
            let saved = core.store.update(&expected, |document| {
                session_state::transition(
                    &mut document.workspace,
                    &document.settings,
                    "session.select",
                    &json!({"id":id}),
                )
            })?;
            Ok(json!({"revision":saved.revision,"result":{"id":id}}))
        }
        "sessions.send" => {
            let text = request.params["text"]
                .as_str()
                .ok_or_else(|| CoreError::new("INVALID_PARAMS", "Input must be text"))?;
            if text.len() > 65536 {
                return Err(CoreError::new("INVALID_PARAMS", "Input exceeds 64 KiB"));
            }
            let generation = options["generation"].as_str().ok_or_else(|| {
                CoreError::new("HOST_NOT_READY", "Reconnect before sending to this session")
            })?;
            let reply = core
                .host_client()?
                .request(utermd_local::daemon::Operation::Write {
                    id: id.clone(),
                    generation: generation.into(),
                    data: text.as_bytes().to_vec(),
                })
                .map_err(|e| CoreError::new("HOST", e.to_string()))?;
            if !matches!(reply, utermd_local::daemon::Reply::Done) {
                return Err(CoreError::new("HOST_REPLY", "Host did not confirm input"));
            }
            Ok(json!({"result":{"id":id}}))
        }
        "sessions.close" => {
            core.dispatch(
                "host.close",
                json!({"id":id,"generation":options["generation"]}),
            )?;
            let saved = core.store.update(&expected, |document| {
                session_state::transition(
                    &mut document.workspace,
                    &document.settings,
                    "session.remove",
                    &json!({"id":id}),
                )
            })?;
            Ok(json!({"revision":saved.revision,"result":{"id":id}}))
        }
        _ => Err(CoreError::new(
            "INVALID_PARAMS",
            "Unsupported control action",
        )),
    }
}
