use serde_json::{json, Value};
use std::time::{Duration, Instant};
use uterm_core::{Core, Response};

fn execute(core: &Core, method: &str, params: Value) -> Response {
    core.execute(
        &serde_json::to_vec(
            &json!({"version":1,"id":"ssh-client-qa","method":method,"params":params}),
        )
        .unwrap(),
    )
}
fn call(core: &Core, method: &str, params: Value) -> Value {
    let response = execute(core, method, params);
    assert!(response.error.is_none(), "{:?}", response.error);
    response.result.unwrap()
}
fn initialized(path: std::path::PathBuf) -> Core {
    let core = Core::open(path).unwrap();
    let defaults = call(&core, "state.defaults", Value::Null);
    call(
        &core,
        "migration.import",
        json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}}),
    );
    core
}
fn change(core: &Core, method: &str, mut params: Value) -> Value {
    params["expectedRevision"] = call(core, "snapshot.read", Value::Null)["revision"].clone();
    call(core, method, params)
}
fn connection() -> Value {
    json!({"connection_id":uuid::Uuid::new_v4().to_string(),"workspace_id":"local","name":"SSH 中文","host":"127.0.0.1","mode":"direct","port":2222,"username":"qa","authentication":"config","os":"posix","root":""})
}
fn wait(core: &Core, job: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let operation = call(
            core,
            "ssh.operation.read",
            json!({"id":job["id"],"generation":job["generation"],"consume":true}),
        );
        if operation["state"] != "running" {
            return operation.clone();
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn profile_cas_dependencies_and_remote_session_rosters_preserve_existing_records() {
    let directory = tempfile::tempdir().unwrap();
    let core = initialized(directory.path().join("shared-state-v1"));
    let connection = connection();
    let original = call(&core, "snapshot.read", Value::Null);
    change(&core, "ssh.profile.save", json!({"connection":connection}));
    let stale = execute(
        &core,
        "ssh.profile.save",
        json!({"connection":connection,"expectedRevision":original["revision"]}),
    );
    assert_eq!(stale.error.unwrap().code, "CONFLICT");
    let mut forbidden = connection.clone();
    forbidden["password"] = json!("DO-NOT-EXPORT");
    let stale = execute(
        &core,
        "ssh.profile.save",
        json!({"connection":forbidden,"expectedRevision":call(&core,"snapshot.read",Value::Null)["revision"]}),
    );
    assert_eq!(stale.error.as_ref().unwrap().code, "SSH_INVALID_CONNECTION");
    assert!(!serde_json::to_string(&stale)
        .unwrap()
        .contains("DO-NOT-EXPORT"));
    change(
        &core,
        "session.create",
        json!({"id":"remote-one","name":"Remote","sshConnectionId":connection["connection_id"],"directory":directory.path()}),
    );
    change(
        &core,
        "session.split",
        json!({"anchor":"remote-one","id":"remote-two","splitId":"remote-split","axis":"horizontal","name":"Remote sibling"}),
    );
    let entries = call(&core, "session.entries", Value::Null);
    assert_eq!(entries.as_array().unwrap().len(), 2);
    for entry in entries.as_array().unwrap() {
        assert_eq!(entry["session"]["ssh"], connection);
    }
    let remove = execute(
        &core,
        "ssh.profile.remove",
        json!({"id":connection["connection_id"],"expectedRevision":call(&core,"snapshot.read",Value::Null)["revision"]}),
    );
    assert_eq!(remove.error.unwrap().code, "SSH_CONNECTION_BUSY");
    let mut renamed = connection.clone();
    renamed["name"] = json!("Renamed");
    renamed["port"] = json!(2223);
    change(&core, "ssh.profile.save", json!({"connection":renamed}));
    let entries_after = call(&core, "session.entries", Value::Null);
    assert_eq!(entries_after, entries);
    change(
        &core,
        "workspace.create",
        json!({"id":"other-workspace","name":"Other"}),
    );
    change(
        &core,
        "session.create",
        json!({"id":"remote-scoped","name":"Scoped","sshConnectionId":connection["connection_id"],"workspaceId":"local","directory":directory.path()}),
    );
    assert_eq!(
        call(&core, "snapshot.read", Value::Null)["document"]["workspace"]["selectedWorkspace"],
        "local"
    );
    let scoped = call(&core, "session.entries", Value::Null);
    assert_eq!(
        scoped
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["session"]["id"] == "remote-scoped")
            .unwrap()["session"]["ssh"],
        renamed
    );

    for id in ["remote-one", "remote-two", "remote-scoped"] {
        change(&core, "session.remove", json!({"id":id}));
    }
    let snapshot = call(&core, "snapshot.read", Value::Null);
    let mut workspace = snapshot["document"]["workspace"].clone();
    workspace["groups"][0]["redisConnections"] = json!([{"id":uuid::Uuid::new_v4().to_string(),"name":"Dependent","host":"127.0.0.1","port":6379,"db":0,"username":"","tls":false,"ca_file":"","server_name":"","ssh_host":"127.0.0.1","ssh_target":renamed,"credential_id":null}]);
    call(
        &core,
        "snapshot.replace",
        json!({"expectedRevision":snapshot["revision"],"workspace":workspace,"settings":snapshot["document"]["settings"]}),
    );
    let mut moved = renamed.clone();
    moved["host"] = json!("localhost");
    let changed = change(&core, "ssh.profile.save", json!({"connection":moved}));
    assert_eq!(
        changed["document"]["workspace"]["groups"][0]["redisConnections"][0]["ssh_target"],
        moved
    );
    assert_eq!(
        changed["document"]["workspace"]["groups"][0]["redisConnections"][0]["ssh_host"],
        "localhost"
    );
    let remove = execute(
        &core,
        "ssh.profile.remove",
        json!({"id":moved["connection_id"],"expectedRevision":changed["revision"]}),
    );
    assert_eq!(remove.error.unwrap().code, "SSH_CONNECTION_BUSY");
    core.close();
}

#[test]
fn asynchronous_credentials_are_not_exported_and_quit_requires_explicit_resume() {
    let directory = tempfile::tempdir().unwrap();
    let core = initialized(directory.path().join("shared-state-v1"));
    let mut connection = connection();
    connection["authentication"] = json!("password");
    let job = call(
        &core,
        "ssh.operation.start",
        json!({"kind":"auth.configure","connection":connection,"password":"isolated-fixture-secret","remember":false}),
    );
    let stale = execute(
        &core,
        "ssh.operation.read",
        json!({"id":job["id"],"generation":uuid::Uuid::new_v4().to_string(),"consume":true}),
    );
    assert_eq!(stale.error.unwrap().code, "SSH_OPERATION_CHANGED");
    let result = wait(&core, &job);
    let consumed = execute(
        &core,
        "ssh.operation.read",
        json!({"id":job["id"],"generation":job["generation"],"consume":true}),
    );
    assert_eq!(
        consumed.error.unwrap().code,
        "SSH_OPERATION_RESULT_CONSUMED"
    );

    assert_eq!(result["state"], "completed");
    let reference = result["result"].as_str().unwrap();
    uuid::Uuid::parse_str(reference).unwrap();
    let operations = call(&core, "ssh.operations", Value::Null);
    let snapshot = call(&core, "snapshot.read", Value::Null);
    for value in [&operations, &snapshot] {
        assert!(!value.to_string().contains("isolated-fixture-secret"));
    }
    let mut malformed = connection.clone();
    malformed["private_key"] = json!("SENSITIVE-VALUE");
    let invalid = execute(
        &core,
        "ssh.operation.start",
        json!({"kind":"auth.configure","connection":malformed,"password":22,"remember":false}),
    );
    assert_eq!(invalid.error.as_ref().unwrap().code, "INVALID_ARGUMENT");
    assert!(!serde_json::to_string(&invalid)
        .unwrap()
        .contains("SENSITIVE-VALUE"));
    let quit = call(&core, "ssh.operation.start", json!({"kind":"prepareQuit"}));
    assert_eq!(wait(&core, &quit)["state"], "completed");
    let refused = execute(
        &core,
        "ssh.operation.start",
        json!({"kind":"auth.forget","reference":reference,"remember":false}),
    );
    assert_eq!(refused.error.unwrap().code, "SSH_QUITTING");
    call(&core, "ssh.resume", Value::Null);
    let forget = call(
        &core,
        "ssh.operation.start",
        json!({"kind":"auth.forget","reference":reference,"remember":false}),
    );
    assert_eq!(wait(&core, &forget)["state"], "completed");
    core.close();
}

#[test]
fn transfer_byte_counts_are_exact_decimal_strings_in_the_control_contract() {
    use uterm_core::ssh::service::{Operation, Progress};
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../shared/contracts/ssh-progress-v1.json"
    ))
    .unwrap();
    for value in fixture["progress"].as_array().unwrap() {
        let progress: Progress = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&progress).unwrap(), *value);
        assert_eq!(progress.total.parse::<u64>().unwrap(), u64::MAX);
        assert!(progress.completed.parse::<u64>().unwrap() > 9_007_199_254_740_992);
    }
    for count in [9_007_199_254_740_993u64, u64::MAX] {
        let operation = Operation {
            id: "qa".into(),
            generation: uuid::Uuid::new_v4().to_string(),
            kind: "files.transfer".into(),
            state: "running".into(),
            progress: Some(Progress {
                name: "中文".into(),
                completed: count.to_string(),
                total: count.to_string(),
            }),
            result: None,
            error: None,
        };
        let value = serde_json::to_value(&operation).unwrap();
        assert_eq!(
            value["progress"]["completed"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap(),
            count
        );
        assert!(value["progress"]["completed"].is_string());
        let roundtrip: Operation = serde_json::from_value(value).unwrap();
        assert_eq!(roundtrip.progress.unwrap().total, count.to_string());
    }
}
