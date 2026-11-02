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
    assert!(response.error.is_none(), "{method}: {:?}", response.error);
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
fn cli_close_rejects_a_stale_generation_and_preserves_the_saved_session() {
    let temporary = tempfile::tempdir().unwrap();
    let core = Core::open(temporary.path().join("shared-state-v1")).unwrap();
    let _cleanup = HostCleanup(temporary.path().join("local-daemon-v1"));
    let defaults = call(&core, "state.defaults", Value::Null);
    let imported = call(
        &core,
        "migration.import",
        json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}}),
    );
    let id = "00000000-0000-4000-8000-000000000029";
    let snapshot = call(
        &core,
        "session.create",
        json!({"expectedRevision":imported["revision"],"id":id,"name":"Control","directory":temporary.path(),"projectId":null}),
    );
    call(&core, "host.configure", json!({"helper":helper()}));
    core.set_terminal_sink(Arc::new(|_, _, _| Ok(()))).unwrap();
    let hosted = call(
        &core,
        "terminal.open",
        json!({"id":id,"attachment":"control","directory":temporary.path(),"shell":if cfg!(windows){"cmd"}else{"default"},"rows":24,"cols":80}),
    );
    call(&core, "control.start", Value::Null);
    call(&core, "control.configure", json!({"enabled":true}));
    for (generation, accepted) in [
        ("stale", false),
        (hosted["generation"].as_str().unwrap(), true),
    ] {
        let root = temporary.path().to_owned();
        let client = std::thread::spawn(move || {
            utermd_local::control::cli(vec![
                "--data-dir".into(),
                root.to_string_lossy().into(),
                "sessions".into(),
                "close".into(),
                id.into(),
            ])
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        let request = loop {
            let request = call(&core, "control.poll", Value::Null);
            if !request.is_null() {
                break request;
            }
            assert!(Instant::now() < deadline, "CLI close did not queue");
            std::thread::sleep(Duration::from_millis(10));
        };
        let response=core.execute(&serde_json::to_vec(&json!({"version":1,"id":"close-cli","method":"control.execute","params":{"requestId":request["id"],"expectedRevision":snapshot["revision"],"generation":generation}})).unwrap());
        if accepted {
            assert!(response.error.is_none(), "{:?}", response.error);
            call(
                &core,
                "control.reply",
                json!({"id":request["id"],"result":{"result":response.result.unwrap()["result"]}}),
            );
            assert_eq!(client.join().unwrap().unwrap()["id"], id);
            assert!(call(&core, "session.entries", Value::Null)
                .as_array()
                .unwrap()
                .is_empty());
        } else {
            assert_eq!(response.error.unwrap().code, "STALE_GENERATION");
            call(
                &core,
                "control.reply",
                json!({"id":request["id"],"result":{"error":"Stale generation"}}),
            );
            assert!(client.join().unwrap().is_err());
            assert_eq!(
                call(&core, "session.entries", Value::Null)
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            assert!(call(&core, "host.status", Value::Null)["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["running"] == true));
        }
    }
    core.close();
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
        json!({"attachment":"first","action":"ack","sequence":first.sequence.to_string()}),
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

fn status(client: &Client) -> utermd_local::daemon::HostStatus {
    match client.request(Operation::HostStatus).unwrap() {
        Reply::HostStatus(status) => status,
        _ => panic!("Expected a real host status"),
    }
}
fn open_upgrade_session(client: &Client, directory: &std::path::Path) -> String {
    match client
        .request(Operation::Open {
            spec: utermd_local::daemon::SessionSpec {
                id: "helper-upgrade-session".into(),
                directory: directory.into(),
                shell: if cfg!(windows) { "cmd" } else { "default" }.into(),
                agent: None,
                ssh: None,
            },
            rows: 24,
            cols: 80,
        })
        .unwrap()
    {
        Reply::Opened { generation } => generation,
        _ => panic!("Expected a real PTY generation"),
    }
}
fn upgrade_session_alive(client: &Client, generation: &str) {
    let id = "helper-upgrade-session".to_string();
    let command = if cfg!(windows) {
        b"set UTERM_UPGRADE_SUFFIX=ALIVE\recho UTERM_UPGRADE_%UTERM_UPGRADE_SUFFIX%\r".as_slice()
    } else {
        b"printf 'UTERM_UPGRADE_%s\\n' ALIVE\r".as_slice()
    };
    client
        .request(Operation::Write {
            id: id.clone(),
            generation: generation.into(),
            data: command.into(),
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut sequence = None;
    let mut bytes = Vec::new();
    while Instant::now() < deadline {
        let Reply::Frame(frame) = client
            .request(Operation::Read {
                id: id.clone(),
                generation: generation.into(),
                after: sequence,
            })
            .unwrap()
        else {
            panic!("Expected a PTY frame")
        };
        assert!(!frame.exited, "The old session must remain alive");
        sequence = Some(frame.sequence);
        bytes.extend(frame.data);
        if bytes
            .windows(19)
            .any(|window| window == b"UTERM_UPGRADE_ALIVE")
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("The retained PTY did not execute the liveness command");
}
#[test]
fn broker_preserves_active_unstaged_host_then_replaces_it_only_when_idle() {
    let root = tempfile::tempdir().unwrap();
    let host_root = root.path().canonicalize().unwrap().join("local-daemon-v1");
    let _cleanup = HostCleanup(host_root.clone());
    let helper = helper();
    let original_bytes = std::fs::read(&helper).unwrap();
    let old = utermd_local::daemon::ensure_running(&host_root, &helper).unwrap();
    let generation = open_upgrade_session(&old, root.path());
    let before = status(&old);
    assert_eq!(before.executable.canonicalize().unwrap(), helper);
    let broker = uterm_core::host::HostBroker::new(host_root.clone(), helper.clone());
    let retained = broker.client().unwrap();
    let active = status(&retained);
    assert_eq!(active.pid, before.pid);
    assert_eq!(active.executable, before.executable);
    assert!(active
        .sessions
        .iter()
        .any(|session| session.running && session.generation == generation));
    upgrade_session_alive(&retained, &generation);
    retained
        .request(Operation::Close {
            id: "helper-upgrade-session".into(),
            generation,
        })
        .unwrap();
    let upgraded = broker.client().unwrap();
    let after = status(&upgraded);
    assert_ne!(after.pid, before.pid);
    assert!(after
        .executable
        .canonicalize()
        .unwrap()
        .starts_with(host_root.join("executables")));
    assert!(!after.sessions.iter().any(|session| session.running));
    let repeated = status(&broker.client().unwrap());
    assert_eq!(
        repeated.pid, after.pid,
        "An unchanged idle helper must not restart"
    );

    assert!(
        std::fs::read(helper).unwrap() == original_bytes,
        "Staging must not alter the bundled source"
    );
}
struct RestoreEndpoint {
    path: PathBuf,
    bytes: Vec<u8>,
}
impl Drop for RestoreEndpoint {
    fn drop(&mut self) {
        if self.path.exists() {
            let _ = std::fs::write(&self.path, &self.bytes);
        }
    }
}
#[test]
fn incompatible_endpoint_does_not_replace_a_live_host_or_its_sessions() {
    let root = tempfile::tempdir().unwrap();
    let host_root = root.path().canonicalize().unwrap().join("local-daemon-v1");
    let _cleanup = HostCleanup(host_root.clone());
    let helper = helper();
    let old = utermd_local::daemon::ensure_running(&host_root, &helper).unwrap();
    let generation = open_upgrade_session(&old, root.path());
    let before = status(&old);
    let path = host_root.join("endpoint.json");
    let saved = RestoreEndpoint {
        bytes: std::fs::read(&path).unwrap(),
        path: path.clone(),
    };
    let mut endpoint: Value = serde_json::from_slice(&saved.bytes).unwrap();
    endpoint["version"] = json!(999);
    let incompatible = serde_json::to_vec(&endpoint).unwrap();
    std::fs::write(&path, &incompatible).unwrap();
    let broker = uterm_core::host::HostBroker::new(host_root.clone(), helper);
    let error = broker
        .client()
        .err()
        .expect("An incompatible endpoint must fail");
    assert!(error.contains("running but unavailable") && error.contains("left intact"));
    assert!(
        std::fs::read(path).unwrap() == incompatible,
        "A live endpoint must not be overwritten"
    );
    let retained = status(&old);
    assert_eq!(retained.pid, before.pid);
    assert!(retained
        .sessions
        .iter()
        .any(|session| session.running && session.generation == generation));
    upgrade_session_alive(&old, &generation);
    // Restore before cleanup so the isolated daemon can be closed even after an assertion fails.
    // 先恢复端点再清理，确保断言失败时也能关闭隔离宿主。
    drop(saved);
}
