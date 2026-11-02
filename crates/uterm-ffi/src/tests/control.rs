use super::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn call(handle: u64, method: &str, params: Value) -> Value {
    let bytes = serde_json::to_vec(
        &json!({"version":1,"id":"control-action","method":method,"params":params}),
    )
    .unwrap();
    let reply = consume(unsafe { uterm_call(handle, bytes.as_ptr(), bytes.len()) });
    assert!(reply.get("error").is_none(), "{reply}");
    reply["result"].clone()
}

#[test]
fn control_mutation_emits_its_committed_revision_and_closes_its_service() {
    unsafe extern "C" fn receive(
        context: *mut c_void,
        _operation: u64,
        bytes: *const u8,
        len: usize,
    ) {
        let sender = unsafe { &*(context as *const std::sync::mpsc::Sender<Vec<u8>>) };
        sender
            .send(unsafe { slice::from_raw_parts(bytes, len) }.to_vec())
            .unwrap();
    }
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary
        .path()
        .join("shared-state-v1")
        .to_str()
        .unwrap()
        .to_string();
    let mut handle = 0;
    consume(unsafe { uterm_open(path.as_ptr(), path.len(), &mut handle) });
    let defaults = call(handle, "state.defaults", Value::Null);
    let snapshot = call(
        handle,
        "migration.import",
        json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}}),
    );
    call(handle, "control.start", Value::Null);
    call(handle, "control.configure", json!({"enabled":true}));
    let (sender, receiver) = std::sync::mpsc::channel::<Vec<u8>>();
    assert_eq!(
        uterm_subscribe(handle, Some(receive), &sender as *const _ as *mut c_void),
        1
    );
    let root = temporary.path().to_owned();
    let client = std::thread::spawn(move || {
        utermd_local::control::cli(vec![
            "--data-dir".into(),
            root.to_string_lossy().into(),
            "sessions".into(),
            "new".into(),
            root.to_string_lossy().into(),
        ])
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let request = loop {
        let request = call(handle, "control.poll", Value::Null);
        if !request.is_null() {
            break request;
        }
        assert!(
            Instant::now() < deadline,
            "CLI did not reach the FFI-owned service"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let saved = call(
        handle,
        "control.execute",
        json!({"requestId":request["id"],"expectedRevision":snapshot["revision"]}),
    );
    let event: Value =
        serde_json::from_slice(&receiver.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
    assert_eq!(event["kind"], "snapshot.changed");
    assert_eq!(event["operationId"], "control-action");
    assert_eq!(event["revision"], saved["revision"]);
    call(
        handle,
        "control.reply",
        json!({"id":request["id"],"result":{"result":saved["result"]}}),
    );
    assert_eq!(client.join().unwrap().unwrap()["id"], saved["result"]["id"]);
    assert_eq!(uterm_subscribe(handle, None, std::ptr::null_mut()), 1);
    assert_eq!(uterm_close(handle), 1);
    assert!(!temporary.path().join("control-v1/endpoint.json").exists());
}
