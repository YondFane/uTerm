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
    assert!(reply.error.is_none(), "{:?}", reply.error);
    reply.result.unwrap()
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
