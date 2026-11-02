use serde_json::{json, Value};
use uterm_core::{state, Core, Response};

fn execute(core: &Core, method: &str, params: Value) -> Response {
    core.execute(
        &serde_json::to_vec(&json!({"version":1,"id":"sessions","method":method,"params":params}))
            .unwrap(),
    )
}
fn call(core: &Core, method: &str, params: Value) -> Value {
    let reply = execute(core, method, params);
    assert!(reply.error.is_none(), "{:?}", reply.error);
    reply.result.unwrap()
}
fn mutate(core: &Core, method: &str, mut params: Value) -> Value {
    params["expectedRevision"] = call(core, "snapshot.read", Value::Null)["revision"].clone();
    call(core, method, params)
}
fn initialize(core: &Core) {
    let defaults = state::defaults();
    call(
        core,
        "migration.import",
        json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}}),
    );
}

#[test]
fn split_selection_resize_removal_and_reopen_share_one_revision_checked_document() {
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().to_path_buf()).unwrap();
    initialize(&core);
    mutate(
        &core,
        "session.create",
        json!({"id":"first","name":"中文","directory":root.path()}),
    );
    let original = call(&core, "snapshot.read", Value::Null);
    mutate(
        &core,
        "session.split",
        json!({"anchor":"first","id":"second","name":"Peer","splitId":"split","axis":"horizontal"}),
    );
    let view = call(&core, "snapshot.view", Value::Null);
    assert_eq!(view["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(view["layout"]["first"]["session"], "first");
    assert_eq!(view["layout"]["second"]["session"], "second");
    let stale = execute(
        &core,
        "session.rename",
        json!({"expectedRevision":original["revision"],"id":"first","name":"Lost"}),
    );
    assert_eq!(stale.error.unwrap().code, "CONFLICT");
    mutate(
        &core,
        "session.resize",
        json!({"rosterId":view["sessions"][0]["rosterId"],"splitId":"split","ratio":0.99}),
    );
    assert_eq!(
        call(&core, "snapshot.view", Value::Null)["layout"]["ratio"],
        0.85
    );
    mutate(&core, "session.remove", json!({"id":"second"}));
    let view = call(&core, "snapshot.view", Value::Null);
    assert_eq!(
        view["snapshot"]["document"]["workspace"]["selectedSession"],
        "first"
    );
    assert_eq!(view["layout"], json!({"kind":"leaf","session":"first"}));
    core.close();
    let reopened = Core::open(root.path().to_path_buf()).unwrap();
    assert_eq!(call(&reopened, "snapshot.view", Value::Null), view);
}

#[test]
fn project_open_deduplicates_per_workspace_and_disabled_agent_failure_is_atomic() {
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().to_path_buf()).unwrap();
    initialize(&core);
    let project =
        json!({"id":"project-a","name":"Project","directory":root.path(),"workspaceId":"local"});
    mutate(&core, "project.open", project.clone());
    mutate(
        &core,
        "project.open",
        json!({"id":"ignored","name":"Same","directory":root.path(),"workspaceId":"local"}),
    );
    let snapshot = call(&core, "snapshot.read", Value::Null);
    assert_eq!(
        snapshot["document"]["workspace"]["projects"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    mutate(
        &core,
        "workspace.create",
        json!({"id":"other","name":"Other","select":true}),
    );
    mutate(
        &core,
        "project.open",
        json!({"id":"project-b","name":"Project","directory":root.path(),"workspaceId":"other"}),
    );
    let snapshot = call(&core, "snapshot.read", Value::Null);
    assert_eq!(
        snapshot["document"]["workspace"]["projects"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    mutate(
        &core,
        "settings.patch",
        json!({"patch":{"enabledAgents":[]}}),
    );
    let before = call(&core, "snapshot.read", Value::Null);
    let failed = execute(
        &core,
        "session.create",
        json!({"id":"agent","name":"Agent","agent":"codex","expectedRevision":before["revision"]}),
    );
    assert_eq!(failed.error.unwrap().code, "AGENT_DISABLED");
    assert_eq!(call(&core, "snapshot.read", Value::Null), before);
}
