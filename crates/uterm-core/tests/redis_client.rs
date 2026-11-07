use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::Arc,
    time::{Duration, Instant},
};
use uterm_core::{
    redis::{
        service::{Operation, Request, Service},
        Config, Host,
    },
    Core, Response,
};

fn host() -> Host {
    Host {
        state: Default::default(),
        identifier: "sh.uterm.qa.redis-core".into(),
        prepare_ssh: Arc::new(|_| Box::pin(async { anyhow::bail!("Unexpected SSH connection") })),
    }
}
fn config(port: u16) -> Config {
    serde_json::from_value(json!({"id":uuid::Uuid::new_v4().to_string(),"name":"QA 中文","host":"127.0.0.1","port":port,"db":0,"username":"qa","tls":false,"ca_file":"","server_name":"","ssh_host":"","credential_id":null})).unwrap()
}
fn wait(service: &Service, operation: &Operation, consume: bool) -> Operation {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let value = service
            .read(&operation.id, &operation.generation, consume)
            .unwrap();
        if value.state != "running" {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "Redis operation did not complete"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn authentication(listener: &TcpListener) -> TcpStream {
    let (mut stream, _) = listener.accept().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut buffer = [0; 4096];
    assert!(stream.read(&mut buffer).unwrap() > 0);
    stream.write_all(b"+OK\r\n").unwrap();
    stream
}
fn closed(mut stream: TcpStream) {
    let mut buffer = [0; 4096];
    assert_eq!(stream.read(&mut buffer).unwrap(), 0);
}

#[test]
fn unread_results_are_bounded_without_starving_disconnect_or_leaking_parameters() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let streams = (0..8)
            .map(|_| authentication(&listener))
            .collect::<Vec<_>>();
        for stream in streams {
            closed(stream);
        }
    });
    let service = Service::new(host()).unwrap();
    let mut jobs = Vec::new();
    for _ in 0..8 {
        let job = service
            .start(Request::Connect {
                config: config(port),
                password: Some("PRIVATE_PASSWORD_MARKER".into()),
            })
            .unwrap();
        assert_eq!(wait(&service, &job, false).state, "completed");
        jobs.push(job);
    }
    assert_eq!(
        service
            .start(Request::Connect {
                config: config(port),
                password: None
            })
            .err()
            .unwrap()
            .to_string(),
        "REDIS_RESULT_LIMIT"
    );
    assert_eq!(
        service
            .read(&jobs[0].id, "stale", true)
            .err()
            .unwrap()
            .to_string(),
        "REDIS_OPERATION_CHANGED"
    );
    let consumed = wait(&service, &jobs[0], true);
    let handle = consumed.result.unwrap()["handle"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        service
            .read(&jobs[0].id, &jobs[0].generation, true)
            .err()
            .unwrap()
            .to_string(),
        "REDIS_RESULT_CONSUMED"
    );
    let disconnect = service.start(Request::Disconnect { handle }).unwrap();
    assert_eq!(wait(&service, &disconnect, true).state, "completed");
    let snapshot = serde_json::to_string(&service.operations().unwrap()).unwrap();
    assert!(!snapshot.contains("PRIVATE_PASSWORD_MARKER"));
    assert!(service
        .operations()
        .unwrap()
        .iter()
        .all(|value| value.result.is_none()));
    service.close();
    service.close();
    server.join().unwrap();
}

#[test]
fn quit_gates_admission_and_resume_retains_hidden_draft_protection() {
    let service = Service::new(host()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let guard = service
        .start(Request::Guard {
            id: id.clone(),
            active: true,
        })
        .unwrap();
    assert_eq!(wait(&service, &guard, true).state, "completed");
    let quit = service.start(Request::Quit).unwrap();
    assert_eq!(wait(&service, &quit, true).state, "completed");
    assert_eq!(
        service
            .start(Request::Guard {
                id: id.clone(),
                active: false
            })
            .err()
            .unwrap()
            .to_string(),
        "REDIS_QUITTING"
    );
    assert_eq!(service.status().unwrap()["dirty"], true);
    service.resume().unwrap();
    assert_eq!(service.status().unwrap()["dirty"], true);
    let guard = service.start(Request::Guard { id, active: false }).unwrap();
    assert_eq!(wait(&service, &guard, true).state, "completed");
    assert_eq!(service.status().unwrap()["dirty"], false);
    service.close();
    assert_eq!(service.resume().err().unwrap().to_string(), "REDIS_CLOSED");
}

#[test]
fn close_during_authentication_releases_transport_and_prevents_late_result_registration() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (sent, received) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = [0; 4096];
        assert!(stream.read(&mut bytes).unwrap() > 0);
        sent.send(()).unwrap();
        closed(stream);
    });
    let host = host();
    let state = host.state.clone();
    let service = Service::new(host).unwrap();
    let job = service
        .start(Request::Connect {
            config: config(port),
            password: Some("PRIVATE_PASSWORD_MARKER".into()),
        })
        .unwrap();
    received.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(state.busy());
    service.close();
    server.join().unwrap();
    assert!(!state.busy());
    let value = service.read(&job.id, &job.generation, true).unwrap();
    assert_eq!(value.state, "failed");
    assert_eq!(value.error.as_deref(), Some("REDIS_CLOSED"));
    assert!(value.result.is_none());
}

fn execute(core: &Core, method: &str, params: Value) -> Response {
    core.execute(
        &serde_json::to_vec(&uterm_core::Request {
            version: 1,
            id: "qa".into(),
            method: method.into(),
            params,
        })
        .unwrap(),
    )
}
#[test]
fn profiles_use_cas_preserve_other_data_and_refuse_secrets_or_dirty_mutations() {
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().join("shared-state-v1")).unwrap();
    let defaults = execute(&core, "state.defaults", Value::Null)
        .result
        .unwrap();
    let initial = execute(
        &core,
        "migration.import",
        json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}}),
    )
    .result
    .unwrap();
    let workspace = initial["document"]["workspace"]["selectedWorkspace"].clone();
    let config = serde_json::to_value(config(6379)).unwrap();
    let id = config["id"].clone();
    let saved = execute(
        &core,
        "redis.profile.save",
        json!({"expectedRevision":initial["revision"],"workspaceId":workspace,"config":config}),
    );
    assert!(saved.error.is_none(), "{:?}", saved.error);
    let saved = saved.result.unwrap();
    assert_eq!(
        saved["document"]["settings"],
        initial["document"]["settings"]
    );
    let stale = execute(
        &core,
        "redis.profile.remove",
        json!({"expectedRevision":initial["revision"],"workspaceId":workspace,"id":id}),
    );
    assert_eq!(stale.error.unwrap().code, "CONFLICT");
    let mut private = config.clone();
    private["password"] = "PRIVATE_PASSWORD_MARKER".into();
    let rejected = execute(
        &core,
        "redis.profile.save",
        json!({"expectedRevision":saved["revision"],"workspaceId":workspace,"config":private}),
    );
    assert_eq!(rejected.error.unwrap().code, "REDIS_INVALID_REQUEST");
    let job = execute(
        &core,
        "redis.operation.start",
        json!({"kind":"guard","id":id,"active":true}),
    )
    .result
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let value = execute(
            &core,
            "redis.operation.read",
            json!({"id":job["id"],"generation":job["generation"],"consume":true}),
        )
        .result
        .unwrap();
        if value["state"] == "completed" {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let refused = execute(
        &core,
        "redis.profile.remove",
        json!({"expectedRevision":saved["revision"],"workspaceId":workspace,"id":id}),
    );
    assert_eq!(refused.error.unwrap().code, "REDIS_BUSY");
    assert_eq!(
        execute(&core, "snapshot.read", Value::Null).result.unwrap(),
        saved
    );
    assert!(!serde_json::to_string(&saved)
        .unwrap()
        .contains("PRIVATE_PASSWORD_MARKER"));
    core.close();
    let reopened = Core::open(root.path().join("shared-state-v1")).unwrap();
    let removed = execute(
        &reopened,
        "redis.profile.remove",
        json!({"expectedRevision":saved["revision"],"workspaceId":workspace,"id":id}),
    );
    assert!(removed.error.is_none(), "{:?}", removed.error);
    assert_eq!(removed.result.unwrap()["document"], initial["document"]);
}

#[test]
fn contract_keeps_binary_and_exact_text_values_through_rust_json() {
    let fixture = include_bytes!("../../../shared/contracts/redis-values-v1.json");
    let operation: Operation = serde_json::from_slice(fixture).unwrap();
    assert_eq!(
        operation.result.as_ref().unwrap()["text"],
        "9223372036854775807 中文🚀"
    );
    assert_eq!(
        serde_json::to_value(operation).unwrap(),
        serde_json::from_slice::<Value>(fixture).unwrap()
    );
}
