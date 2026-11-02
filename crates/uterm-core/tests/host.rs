use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
use uterm_core::Core;
use utermd_local::daemon::{Client, Operation, Reply};

fn call(core: &Core, method: &str, params: Value) -> Value {
    let response = core.execute(
        &serde_json::to_vec(&json!({"version":1,"id":"host-test","method":method,"params":params}))
            .unwrap(),
    );
    assert!(response.error.is_none(), "{:?}", response.error);
    response.result.unwrap()
}
fn helper() -> PathBuf {
    let name = if cfg!(windows) {
        "utermd-local.exe"
    } else {
        "utermd-local"
    };
    let path = if let Some(target) = std::env::var_os("CARGO_TARGET_DIR") {
        PathBuf::from(target).join("debug").join(name)
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../utermd-local/target/debug")
            .join(name)
    };
    assert!(
        path.is_file(),
        "Build the standalone helper first with pnpm test:core"
    );
    path.canonicalize().unwrap()
}
struct HostCleanup(PathBuf);
impl Drop for HostCleanup {
    fn drop(&mut self) {
        if let Ok(client) = Client::connect(&self.0) {
            if let Ok(Reply::HostStatus(status)) = client.request(Operation::HostStatus) {
                for session in status.sessions {
                    let _ = client.request(Operation::Close {
                        id: session.spec.id,
                        generation: session.generation,
                    });
                }
            }
            let _ = client.request(Operation::ShutdownIfIdle);
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.0.join("endpoint.json").exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
}
#[test]
fn real_shared_terminal_preserves_backpressure_generation_replay_and_detached_processes() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("shared-state-v1");
    let host_root = root.path().join("local-daemon-v1");
    let _cleanup = HostCleanup(host_root.clone());
    let helper = helper();
    let core = Core::open(state.clone()).unwrap();
    call(&core, "host.configure", json!({"helper":helper}));
    let (sender, receiver) = mpsc::channel();
    core.set_terminal_sink(Arc::new(move |attachment, generation, frame| {
        sender
            .send((attachment.to_string(), generation.to_string(), frame))
            .map_err(|e| e.to_string())
    }))
    .unwrap();
    let id = "00000000-0000-4000-8000-000000000001";
    let shell = if cfg!(windows) { "cmd" } else { "default" };
    let request = json!({"id":id,"attachment":"first","directory":root.path(),"shell":shell,"rows":24,"cols":80});
    let generation = call(&core, "terminal.open", request.clone())["generation"]
        .as_str()
        .unwrap()
        .to_string();
    let (attachment, received_generation, first) =
        receiver.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(attachment, "first");
    assert_eq!(received_generation, generation);
    let command = if cfg!(windows) {
        b"set UTERM_QA_SUFFIX=READY\recho UTERM_CORE_%UTERM_QA_SUFFIX%\r".as_slice()
    } else {
        b"printf 'UTERM_CORE_%s\\n' READY\r".as_slice()
    };
    core.terminal_write("first", command).unwrap();
    assert!(
        receiver.recv_timeout(Duration::from_millis(50)).is_err(),
        "The next frame must wait for actual consumption"
    );
    call(
        &core,
        "terminal.action",
        json!({"attachment":"first","action":"ack","sequence":first.sequence}),
    );
    let mut output = first.data;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !output.windows(16).any(|w| w == b"UTERM_CORE_READY") {
        assert!(Instant::now() < deadline);
        let (_, received, frame) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(received, generation);
        output.extend_from_slice(&frame.data);
        call(
            &core,
            "terminal.action",
            json!({"attachment":"first","action":"ack","sequence":frame.sequence}),
        );
    }
    core.close();
    drop(core);
    let client = Client::connect(&host_root).unwrap();
    let Reply::HostStatus(status) = client.request(Operation::HostStatus).unwrap() else {
        panic!("Invalid host status")
    };
    assert!(status.sessions.iter().any(|s| s.spec.id == id && s.running));
    let reopened = Core::open(state).unwrap();
    call(&reopened, "host.configure", json!({"helper":helper}));
    let (sender, receiver) = mpsc::channel();
    reopened
        .set_terminal_sink(Arc::new(move |_, generation, frame| {
            sender
                .send((generation.to_string(), frame))
                .map_err(|e| e.to_string())
        }))
        .unwrap();
    let mut attach = request;
    attach["attachment"] = json!("reopened");
    attach["reconnectOnly"] = json!(true);
    assert_eq!(
        call(&reopened, "terminal.open", attach)["generation"],
        generation
    );
    let (received, frame) = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(received, generation);
    assert!(frame.reset);
    assert!(String::from_utf8_lossy(&frame.data).contains("UTERM_CORE_READY"));
    call(
        &reopened,
        "terminal.action",
        json!({"attachment":"reopened","action":"ack","sequence":frame.sequence}),
    );
    for expected in [Value::Null, json!("stale")] {
        let reply = reopened.execute(&serde_json::to_vec(&json!({"version":1,"id":"stale-close","method":"host.close","params":{"id":id,"generation":expected}})).unwrap());
        assert_eq!(reply.error.unwrap().code, "STALE_GENERATION");
        let Reply::HostStatus(status) = client.request(Operation::HostStatus).unwrap() else {
            panic!("Invalid host status")
        };
        assert!(status
            .sessions
            .iter()
            .any(|s| s.spec.id == id && s.generation == generation && s.running));
    }
    call(
        &reopened,
        "host.close",
        json!({"id":id,"generation":generation}),
    );
    reopened.close();
    let Reply::HostStatus(status) = client.request(Operation::HostStatus).unwrap() else {
        panic!("Invalid host status")
    };
    assert!(!status.sessions.iter().any(|s| s.spec.id == id && s.running));
}
