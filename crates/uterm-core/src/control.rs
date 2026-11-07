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
            let link = core
                .links
                .find(&id)
                .map_err(|error| CoreError::new("HOST_NOT_READY", error))?;
            if link.generation != generation {
                return Err(CoreError::new(
                    "STALE_GENERATION",
                    "The session changed; send cancelled",
                ));
            }
            let reply = link
                .client
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::Arc,
        time::{Duration, Instant},
    };

    #[test]
    fn cli_send_uses_the_current_attachment_lease_and_never_takes_control_implicitly() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let core = Core::open(root.join("shared-state-v1")).unwrap();
        let other = Core::open(root.join("shared-state-v1")).unwrap();
        let invoke =
            |core: &Core, method: &str, params: Value| core.dispatch(method, params).unwrap();
        let defaults = invoke(&core, "state.defaults", Value::Null);
        let imported = invoke(
            &core,
            "migration.import",
            json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}}),
        );
        let created = execute(
            &core,
            Request {
                id: "new".into(),
                method: "sessions.new".into(),
                params: json!({"directory":root}),
            },
            &json!({"expectedRevision":imported["revision"]}),
        )
        .unwrap();
        let id = created["result"]["id"].as_str().unwrap().to_owned();
        let name = if cfg!(windows) {
            "utermd-local.exe"
        } else {
            "utermd-local"
        };
        let helper = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../utermd-local/target")
            })
            .join("debug")
            .join(name)
            .canonicalize()
            .unwrap();
        for client in [&core, &other] {
            invoke(client, "host.configure", json!({"helper":helper}));
            client
                .set_terminal_sink(Arc::new(|_, _, _| Ok(())))
                .unwrap();
        }
        struct Cleanup<'a>(&'a Core);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                if let Ok(status) = self.0.dispatch("host.status", Value::Null) {
                    for session in status["sessions"].as_array().unwrap() {
                        let _ = self.0.dispatch(
                            "host.close",
                            json!({"id":session["spec"]["id"],"generation":session["generation"]}),
                        );
                    }
                    let _ = self.0.dispatch("host.shutdownIdle", Value::Null);
                }
            }
        }
        let _cleanup = Cleanup(&core);
        let open = |attachment: &str| json!({"id":id,"attachment":attachment,"directory":root,"shell":"default","rows":24,"cols":80});
        let generation = invoke(&core, "terminal.open", open("cli-owner"))["generation"].clone();
        invoke(&other, "terminal.open", open("cli-other"));
        let send = |text: &str, generation: Value| {
            execute(
                &core,
                Request {
                    id: "send".into(),
                    method: "sessions.send".into(),
                    params: json!({"id":id,"text":text}),
                },
                &json!({"expectedRevision":created["revision"],"generation":generation}),
            )
        };
        let enter = if cfg!(windows) { "\r" } else { "\n" };
        send(
            &format!("echo FIRST > cli-first.txt{enter}"),
            generation.clone(),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("cli-first.txt").exists() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        invoke(
            &other,
            "terminal.action",
            json!({"attachment":"cli-other","action":"takeControl"}),
        );
        let error = send(
            &format!("echo STALE > cli-stale.txt{enter}"),
            generation.clone(),
        )
        .unwrap_err();
        assert!(
            error.message.contains("SESSION_CONTROL_REQUIRED"),
            "{error:?}"
        );
        let stale = send("ignored", json!("old-generation")).unwrap_err();
        assert_eq!(stale.code, "STALE_GENERATION");
        invoke(
            &core,
            "terminal.action",
            json!({"attachment":"cli-owner","action":"takeControl"}),
        );
        send(
            &format!("echo RETURNED > cli-returned.txt{enter}"),
            generation,
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("cli-returned.txt").exists() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!root.join("cli-stale.txt").exists());
    }
}
