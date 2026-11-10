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
fn github_links_preserve_revisions_sessions_and_reject_stale_or_malformed_updates() {
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().to_path_buf()).unwrap();
    initialize(&core);
    let link = json!({"url":"https://github.com/fixture-owner/fixture-repo/issues/7","title":"中文 `literal` $(literal)"});
    mutate(
        &core,
        "session.create",
        json!({"id":"linked","name":"Linked","directory":root.path(),"issue":link}),
    );
    let original = call(&core, "snapshot.read", Value::Null);
    let next = json!({"url":"https://github.com/fixture-owner/fixture-repo/pull/8","title":"PR"});
    mutate(&core, "session.issue", json!({"id":"linked","issue":next}));
    let saved = call(&core, "snapshot.view", Value::Null);
    assert_eq!(saved["sessions"][0]["session"]["issue"], next);
    let stale = execute(
        &core,
        "session.issue",
        json!({"expectedRevision":original["revision"],"id":"linked","issue":link}),
    );
    assert_eq!(stale.error.unwrap().code, "CONFLICT");
    for url in [
        "javascript:alert(1)",
        "https://github.com.evil/owner/repo/issues/1",
        "https://github.com/owner/repo/issues/1\n",
    ] {
        let result = execute(
            &core,
            "session.issue",
            json!({"expectedRevision":saved["snapshot"]["revision"],"id":"linked","issue":{"url":url,"title":"Invalid"}}),
        );
        assert!(result.error.is_some(), "{url}");
        assert_eq!(call(&core, "snapshot.view", Value::Null), saved);
    }
    core.close();
    let reopened = Core::open(root.path().to_path_buf()).unwrap();
    assert_eq!(call(&reopened, "snapshot.view", Value::Null), saved);
    mutate(
        &reopened,
        "session.split",
        json!({"anchor":"linked","id":"peer","name":"Peer","splitId":"split","axis":"horizontal"}),
    );
    let view = call(&reopened, "snapshot.view", Value::Null);
    assert_eq!(view["sessions"][0]["session"]["issue"], next);
    assert!(view["sessions"][1]["session"].get("issue").is_none());
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

#[test]
fn existing_sessions_group_reposition_ungroup_and_reopen_without_replacing_descriptors() {
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().to_path_buf()).unwrap();
    initialize(&core);
    for id in ["a", "b", "c", "d"] {
        mutate(
            &core,
            "session.create",
            json!({"id":id,"name":id,"directory":root.path()}),
        );
    }
    let descriptors = call(&core, "session.entries", Value::Null);
    mutate(
        &core,
        "session.group",
        json!({"id":"b","anchor":"a","splitId":"ab"}),
    );
    mutate(
        &core,
        "session.resize",
        json!({"rosterId":"terminals:local","splitId":"ab","ratio":0.7}),
    );
    mutate(
        &core,
        "session.group",
        json!({"id":"d","anchor":"c","splitId":"cd","axis":"vertical","before":true}),
    );
    mutate(
        &core,
        "session.resize",
        json!({"rosterId":"terminals:local","splitId":"cd","ratio":0.65}),
    );
    mutate(
        &core,
        "session.group",
        json!({"id":"b","anchor":"c","splitId":"bc"}),
    );
    let view = call(&core, "snapshot.view", Value::Null);
    assert_eq!(view["sessions"], descriptors);
    assert_eq!(
        view["layout"],
        json!({"kind":"split","id":"cd","axis":"vertical","ratio":0.65,
        "first":{"kind":"leaf","session":"d"},
        "second":{"kind":"split","id":"bc","axis":"horizontal","ratio":0.5,
            "first":{"kind":"leaf","session":"c"},"second":{"kind":"leaf","session":"b"}}})
    );
    assert_eq!(
        view["snapshot"]["document"]["workspace"]["groups"][0]["terminalSplits"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let before = call(&core, "snapshot.read", Value::Null);
    let already_grouped = execute(
        &core,
        "session.group",
        json!({"expectedRevision":before["revision"],"id":"d","anchor":"b","splitId":"invalid"}),
    );
    assert_eq!(already_grouped.error.unwrap().code, "INVALID_ARGUMENT");
    assert_eq!(call(&core, "snapshot.read", Value::Null), before);
    mutate(
        &core,
        "session.movePane",
        json!({"id":"d","anchor":"b","splitId":"db","axis":"vertical","before":true}),
    );
    let view = call(&core, "snapshot.view", Value::Null);
    assert_eq!(view["layout"]["id"], "bc");
    assert_eq!(view["layout"]["second"]["first"]["session"], "d");
    assert_eq!(view["layout"]["second"]["second"]["session"], "b");
    assert_eq!(view["sessions"], descriptors);
    mutate(&core, "session.ungroup", json!({"id":"c"}));
    let view = call(&core, "snapshot.view", Value::Null);
    assert_eq!(view["layout"], json!({"kind":"leaf","session":"c"}));
    assert_eq!(
        view["snapshot"]["document"]["workspace"]["selectedSession"],
        "c"
    );
    mutate(&core, "session.select", json!({"id":"b"}));
    let view = call(&core, "snapshot.view", Value::Null);
    assert_eq!(view["layout"]["id"], "db");
    assert_eq!(view["sessions"], descriptors);
    core.close();
    let reopened = Core::open(root.path().to_path_buf()).unwrap();
    assert_eq!(call(&reopened, "snapshot.view", Value::Null), view);
}

#[test]
fn session_order_and_group_boundaries_reject_stale_or_cross_scope_writes_atomically() {
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().to_path_buf()).unwrap();
    initialize(&core);
    let mut document = state::defaults();
    let session = |id: &str, tree: Option<&str>, pinned: bool| {
        let mut value = json!({"id":id,"name":id,"shell":"default","pinned":pinned});
        if let Some(tree) = tree {
            value["worktreeId"] = json!(tree);
        }
        value
    };
    document["workspace"]["projects"] = json!([{
        "id":"project","name":"Project","directory":root.path(),"workspaceId":"local",
        "sessions":[session("a",None,false),session("tree",Some("wt"),false),session("b",None,false),session("pinned",None,true),session("c",None,false)],
        "splitGroups":[],"worktrees":[{"id":"wt","name":"Worktree","path":root.path(),"branch":"qa","missing":false}]
    }]);
    let revision = call(&core, "snapshot.read", Value::Null)["revision"].clone();
    call(
        &core,
        "snapshot.replace",
        json!({"expectedRevision":revision,"workspace":document["workspace"],"settings":document["settings"]}),
    );
    mutate(&core, "session.select", json!({"id":"b"}));
    let old = call(&core, "snapshot.read", Value::Null);
    mutate(
        &core,
        "session.reorder",
        json!({"id":"c","target":"a","after":false}),
    );
    let reordered = call(&core, "snapshot.read", Value::Null);
    let items = reordered["document"]["workspace"]["projects"][0]["sessions"]
        .as_array()
        .unwrap();
    assert_eq!(
        items
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["c", "tree", "a", "pinned", "b"]
    );
    assert_eq!(reordered["document"]["workspace"]["selectedSession"], "b");
    let stale = execute(
        &core,
        "session.reorder",
        json!({"expectedRevision":old["revision"],"id":"a","target":"b","after":true}),
    );
    assert_eq!(stale.error.unwrap().code, "CONFLICT");
    assert_eq!(call(&core, "snapshot.read", Value::Null), reordered);
    for (method, mut params) in [
        (
            "session.reorder",
            json!({"id":"a","target":"tree","after":true}),
        ),
        (
            "session.reorder",
            json!({"id":"a","target":"pinned","after":true}),
        ),
        (
            "session.reorder",
            json!({"id":"a","target":"b","after":"false"}),
        ),
        (
            "session.group",
            json!({"id":"a","anchor":"tree","splitId":"bad"}),
        ),
        (
            "session.movePane",
            json!({"id":"a","anchor":"a","splitId":"bad","axis":"horizontal"}),
        ),
        (
            "session.movePane",
            json!({"id":"a","anchor":"b","splitId":"bad","axis":"diagonal"}),
        ),
        ("session.pin", json!({"id":"a","pinned":"true"})),
    ] {
        params["expectedRevision"] = reordered["revision"].clone();
        assert!(execute(&core, method, params).error.is_some(), "{method}");
        assert_eq!(call(&core, "snapshot.read", Value::Null), reordered);
    }
    mutate(&core, "session.pin", json!({"id":"a","pinned":true}));
    mutate(
        &core,
        "session.reorder",
        json!({"id":"a","target":"pinned","after":true}),
    );
    let before = call(&core, "snapshot.read", Value::Null);
    mutate(
        &core,
        "workspace.create",
        json!({"id":"other","name":"Other","select":true}),
    );
    mutate(
        &core,
        "session.create",
        json!({"id":"foreign","name":"Foreign","directory":root.path()}),
    );
    let current = call(&core, "snapshot.read", Value::Null);
    let denied = execute(
        &core,
        "session.group",
        json!({"expectedRevision":current["revision"],"id":"a","anchor":"foreign","splitId":"bad"}),
    );
    assert_eq!(denied.error.unwrap().code, "INVALID_ARGUMENT");
    assert_eq!(call(&core, "snapshot.read", Value::Null), current);
    assert_eq!(
        before["document"]["workspace"]["projects"][0]["sessions"],
        current["document"]["workspace"]["projects"][0]["sessions"]
    );
}
