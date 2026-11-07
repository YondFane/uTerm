use serde_json::{json, Value};
use std::time::{Duration, Instant};
use uterm_core::Core;

fn call(core: &Core, method: &str, params: Value) -> Value {
    let reply = core.execute(
        &serde_json::to_vec(
            &json!({"version":1,"id":"control-test","method":method,"params":params}),
        )
        .unwrap(),
    );
    assert!(reply.error.is_none(), "{method}: {:?}", reply.error);
    reply.result.unwrap()
}

fn queued(
    core: &Core,
    root: &std::path::Path,
    args: &[&str],
) -> (
    Value,
    std::thread::JoinHandle<std::result::Result<Value, String>>,
) {
    let mut command = vec![
        "--data-dir".to_string(),
        root.to_string_lossy().into_owned(),
    ];
    command.extend(args.iter().map(|s| s.to_string()));
    let client = std::thread::spawn(move || utermd_local::control::cli(command));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let request = call(core, "control.poll", Value::Null);
        if !request.is_null() {
            return (request, client);
        }
        if client.is_finished() {
            panic!("CLI finished before queueing: {:?}", client.join().unwrap());
        }
        assert!(Instant::now() < deadline, "Control request was not queued");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn control_actions_preserve_single_execution_and_stale_writes() {
    let temporary = tempfile::tempdir().unwrap();
    let core = Core::open(temporary.path().join("shared-state-v1")).unwrap();
    let defaults = call(&core, "state.defaults", Value::Null);
    let imported = call(
        &core,
        "migration.import",
        json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}}),
    );
    call(&core, "control.start", Value::Null);
    call(&core, "control.configure", json!({"enabled":true}));
    let (request, client) = queued(
        &core,
        temporary.path(),
        &["sessions", "new", temporary.path().to_str().unwrap()],
    );
    let result = call(
        &core,
        "control.execute",
        json!({"requestId":request["id"],"expectedRevision":imported["revision"]}),
    );
    let session = result["result"]["id"].as_str().unwrap().to_string();
    assert_ne!(
        result["result"]["id"], request["id"],
        "Session and operation identity have separate roles"
    );
    let duplicate=core.execute(&serde_json::to_vec(&json!({"version":1,"id":"duplicate","method":"control.execute","params":{"requestId":request["id"],"expectedRevision":result["revision"]}})).unwrap());
    assert_eq!(duplicate.error.unwrap().code, "CONTROL");
    call(
        &core,
        "control.reply",
        json!({"id":request["id"],"result":{"result":result["result"]}}),
    );
    assert_eq!(client.join().unwrap().unwrap()["id"], session);
    let current = call(&core, "snapshot.read", Value::Null);
    assert_eq!(
        call(&core, "session.entries", Value::Null)
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let (request, client) = queued(
        &core,
        temporary.path(),
        &["sessions", "new", temporary.path().to_str().unwrap()],
    );
    call(
        &core,
        "settings.patch",
        json!({"expectedRevision":current["revision"],"patch":{"fontSize":20}}),
    );
    let stale=core.execute(&serde_json::to_vec(&json!({"version":1,"id":"stale","method":"control.execute","params":{"requestId":request["id"],"expectedRevision":current["revision"]}})).unwrap());
    assert_eq!(stale.error.unwrap().code, "CONFLICT");
    call(
        &core,
        "control.reply",
        json!({"id":request["id"],"result":{"error":"Snapshot changed"}}),
    );
    assert!(client.join().unwrap().unwrap_err().contains("changed"));
    assert_eq!(
        call(&core, "session.entries", Value::Null)
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let snapshot = call(&core, "snapshot.read", Value::Null);
    let (request, client) = queued(
        &core,
        temporary.path(),
        &["open", &format!("uterm://session/{session}")],
    );
    let result = call(
        &core,
        "control.execute",
        json!({"requestId":request["id"],"expectedRevision":snapshot["revision"]}),
    );
    call(
        &core,
        "control.reply",
        json!({"id":request["id"],"result":{"result":result["result"]}}),
    );
    assert_eq!(client.join().unwrap().unwrap()["id"], session);
    core.close();
}

#[test]
fn cli_project_root_does_not_inherit_the_selected_worktree_or_create_a_loose_session() {
    let temporary = tempfile::tempdir().unwrap();
    let core = Core::open(temporary.path().join("shared-state-v1")).unwrap();
    let defaults = call(&core, "state.defaults", Value::Null);
    let imported = call(
        &core,
        "migration.import",
        json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}}),
    );
    let root = temporary.path().canonicalize().unwrap();
    let project = call(
        &core,
        "project.open",
        json!({"expectedRevision":imported["revision"],"id":"p","name":"Project","directory":root,"workspaceId":"local"}),
    );
    let tree = root.join("worktree");
    std::fs::create_dir(&tree).unwrap();
    let mut workspace = project["document"]["workspace"].clone();
    workspace["projects"][0]["worktrees"] =
        json!([{"id":"tree","name":"Worktree","path":tree,"branch":"qa"}]);
    workspace["selectedWorktree"] = json!("tree");
    workspace["groups"][0]["selectedWorktree"] = json!("tree");
    let before = call(
        &core,
        "snapshot.replace",
        json!({"expectedRevision":project["revision"],"workspace":workspace,"settings":defaults["settings"]}),
    );
    call(&core, "control.start", Value::Null);
    call(&core, "control.configure", json!({"enabled":true}));
    let (request, client) = queued(
        &core,
        temporary.path(),
        &["sessions", "new", temporary.path().to_str().unwrap()],
    );
    let result = call(
        &core,
        "control.execute",
        json!({"requestId":request["id"],"expectedRevision":before["revision"]}),
    );
    let entries = call(&core, "session.entries", Value::Null);
    assert_eq!(entries[0]["projectId"], "p");
    assert!(
        entries[0]["session"].get("worktreeId").is_none(),
        "CLI project root must not inherit the current tree"
    );
    assert_eq!(entries[0]["directory"], root.to_str().unwrap());
    call(
        &core,
        "control.reply",
        json!({"id":request["id"],"result":{"result":result["result"]}}),
    );
    assert_eq!(
        client.join().unwrap().unwrap()["id"],
        result["result"]["id"]
    );
    core.close();
}

#[test]
fn core_control_owns_its_service_and_close_releases_pending_clients_and_lease() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("shared-state-v1");
    let core = Core::open(root.clone()).unwrap();
    assert_eq!(call(&core, "control.start", Value::Null)["enabled"], false);
    assert_eq!(
        call(&core, "control.configure", json!({"enabled":true}))["enabled"],
        true
    );
    let other = Core::open(root.clone()).unwrap();
    let rejected = other.execute(br#"{"version":1,"id":"competing","method":"control.start"}"#);
    assert_eq!(rejected.error.unwrap().code, "CONTROL");
    let path = temporary.path().to_owned();
    let client = std::thread::spawn(move || {
        utermd_local::control::cli(vec![
            "--data-dir".into(),
            path.to_string_lossy().into(),
            "status".into(),
        ])
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let request = loop {
        let request = call(&core, "control.poll", Value::Null);
        if !request.is_null() {
            break request;
        }
        if client.is_finished() {
            panic!("CLI finished before queueing: {:?}", client.join().unwrap());
        }
        assert!(
            Instant::now() < deadline,
            "Core control did not receive the actual socket request"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(request["method"], "status");
    core.close();
    assert!(client.join().unwrap().unwrap_err().contains("closed"));
    assert!(!temporary.path().join("control-v1/endpoint.json").exists());
    assert_eq!(call(&other, "control.start", Value::Null)["enabled"], true);
    call(
        &other,
        "control.reply",
        json!({"id":request["id"],"result":{"result":"late"}}),
    );
    assert!(call(&other, "control.poll", Value::Null).is_null());
    other.close();
}
