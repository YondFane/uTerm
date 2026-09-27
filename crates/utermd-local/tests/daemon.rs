use std::path::PathBuf;
use std::time::{Duration, Instant};
use utermd_local::daemon::{ensure_running, Client, Frame, Operation, Reply, SessionSpec};

struct RunningHost {
    directory: PathBuf,
    client: Client,
    sessions: Vec<(String, String)>,
}
impl RunningHost {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("uterm-host-test-{}", uuid::Uuid::new_v4()));
        let client = ensure_running(
            &directory,
            std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
        )
        .expect("start host");
        Self {
            directory,
            client,
            sessions: vec![],
        }
    }
    fn open(&mut self, id: &str) -> String {
        let spec = SessionSpec {
            id: id.into(),
            directory: self.directory.clone(),
            shell: "default".into(),
            agent: None,
        };
        match self
            .client
            .request(Operation::Open {
                spec,
                rows: 24,
                cols: 80,
            })
            .expect("open")
        {
            Reply::Opened { generation } => {
                self.sessions.push((id.into(), generation.clone()));
                generation
            }
            reply => panic!("{reply:?}"),
        }
    }
    fn write(&self, id: &str, generation: &str, data: &str) {
        self.client
            .request(Operation::Write {
                id: id.into(),
                generation: generation.into(),
                data: data.as_bytes().to_vec(),
            })
            .expect("write");
    }
    fn read(&self, id: &str, generation: &str, after: Option<u64>) -> Frame {
        match self
            .client
            .request(Operation::Read {
                id: id.into(),
                generation: generation.into(),
                after,
            })
            .expect("read")
        {
            Reply::Frame(frame) => frame,
            reply => panic!("{reply:?}"),
        }
    }
    #[cfg(unix)]
    fn until(&self, id: &str, generation: &str, expected: &str) -> Frame {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let frame = self.read(id, generation, None);
            if String::from_utf8_lossy(&frame.data).contains(expected) {
                return frame;
            }
            assert!(
                Instant::now() < deadline,
                "missing {expected}: {}",
                String::from_utf8_lossy(&frame.data)
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
impl Drop for RunningHost {
    fn drop(&mut self) {
        for (id, generation) in &self.sessions {
            if let Err(error) = self.client.request(Operation::Close {
                id: id.clone(),
                generation: generation.clone(),
            }) {
                eprintln!("test cleanup: {error}");
            }
        }
        if let Err(error) = self.client.request(Operation::ShutdownIfEmpty) {
            eprintln!("test shutdown: {error}");
        }
        std::thread::sleep(Duration::from_millis(100));
        if let Err(error) = std::fs::remove_dir_all(&self.directory) {
            eprintln!("test directory cleanup: {error}");
        }
    }
}

#[test]
fn local_discovery_does_not_keep_closed_sessions() {
    let mut host = RunningHost::new();
    let generation = host.open("discovered");
    let Reply::Sessions(sessions) = host.client.request(Operation::ListSessions).unwrap() else {
        panic!("session list reply");
    };
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "discovered");
    host.client
        .request(Operation::Close {
            id: "discovered".into(),
            generation,
        })
        .unwrap();
    host.sessions.clear();
    let Reply::Sessions(sessions) = host.client.request(Operation::ListSessions).unwrap() else {
        panic!("session list reply");
    };
    assert!(sessions.is_empty());
    let Reply::SessionSnapshot(snapshot) = host.client.request(Operation::SessionSnapshot).unwrap()
    else {
        panic!("session snapshot reply");
    };
    assert!(snapshot.sessions.is_empty());
    assert!(snapshot.closed.iter().any(|id| id == "discovered"));
}

#[test]
fn session_requires_an_explicit_existing_directory() {
    let host = RunningHost::new();
    for directory in [PathBuf::new(), host.directory.join("missing")] {
        assert!(host
            .client
            .request(Operation::Open {
                spec: SessionSpec {
                    id: "invalid-directory".into(),
                    directory,
                    shell: "default".into(),
                    agent: None,
                },
                rows: 24,
                cols: 80,
            })
            .is_err());
    }
    let Reply::HostStatus(status) = host.client.request(Operation::HostStatus).unwrap() else {
        panic!("host status");
    };
    assert!(status.sessions.is_empty());
}

#[test]
fn host_management_refuses_live_sessions_and_restarts_after_exit() {
    let mut host = RunningHost::new();
    let generation = host.open("managed");
    let Reply::HostStatus(status) = host.client.request(Operation::HostStatus).unwrap() else {
        panic!("host status");
    };
    assert_eq!(status.sessions.len(), 1);
    assert_eq!(status.sessions[0].generation, generation);
    assert!(status.sessions[0].running);
    assert!(host.client.request(Operation::ShutdownIfIdle).is_err());
    assert_eq!(host.open("managed"), generation);
    assert!(host
        .client
        .request(Operation::Close {
            id: "managed".into(),
            generation: "stale".into()
        })
        .is_err());
    host.write("managed", &generation, "exit\r");
    let deadline = Instant::now() + Duration::from_secs(15);
    while !host.read("managed", &generation, None).exited {
        assert!(Instant::now() < deadline, "shell did not exit");
        std::thread::sleep(Duration::from_millis(50));
    }
    let Reply::HostStatus(exited) = host.client.request(Operation::HostStatus).unwrap() else {
        panic!("host status");
    };
    assert!(!exited.sessions[0].running);
    host.client.request(Operation::ShutdownIfIdle).unwrap();
    host.sessions.clear();
    let deadline = Instant::now() + Duration::from_secs(5);
    while host.directory.join("endpoint.json").exists() {
        assert!(Instant::now() < deadline, "host did not stop");
        std::thread::sleep(Duration::from_millis(50));
    }
    host.client = ensure_running(
        &host.directory,
        std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
    )
    .unwrap();
    let Reply::HostStatus(restarted) = host.client.request(Operation::HostStatus).unwrap() else {
        panic!("host status");
    };
    assert_ne!(restarted.pid, status.pid);
    assert!(restarted.sessions.is_empty());
}

#[test]
fn startup_is_singleton_and_does_not_accept_stale_generations() {
    let mut host = RunningHost::new();
    let first = host.client.request(Operation::Ping).expect("ping");
    let second = ensure_running(
        &host.directory,
        std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
    )
    .expect("reconnect")
    .request(Operation::Ping)
    .expect("ping");
    match (first, second) {
        (Reply::Ready { pid: a, .. }, Reply::Ready { pid: b, .. }) => assert_eq!(a, b),
        _ => panic!("ping"),
    }
    let generation = host.open("one");
    assert_eq!(host.open("one"), generation);
    assert!(host
        .client
        .request(Operation::Close {
            id: "one".into(),
            generation: "stale".into()
        })
        .is_err());
    assert!(host.client.request(Operation::ShutdownIfEmpty).is_err());
}

#[cfg(unix)]
#[test]
fn reconnect_preserves_process_environment_output_and_exit() {
    let mut host = RunningHost::new();
    let generation = host.open("persist");
    host.write("persist", &generation, "export UTERM_DURABLE_MARKER=durable; printf 'pid=%s\\n' \"$$\" > pid.txt; printf 'first:%s\\n' \"$UTERM_DURABLE_MARKER\"\n");
    host.until("persist", &generation, "first:durable");
    let pid = std::fs::read_to_string(host.directory.join("pid.txt")).expect("pid");
    let reconnected = ensure_running(
        &host.directory,
        std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
    )
    .expect("reconnect");
    host.client = reconnected;
    assert_eq!(host.open("persist"), generation);
    host.write(
        "persist",
        &generation,
        "printf 'after:%s pid=%s\\n' \"$UTERM_DURABLE_MARKER\" \"$$\"\n",
    );
    let frame = host.until("persist", &generation, "after:durable");
    assert!(frame.reset);
    assert!(String::from_utf8_lossy(&frame.data).contains(pid.trim()));
    host.write("persist", &generation, "exit 7\n");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let frame = host.read("persist", &generation, None);
        if frame.exited {
            assert_eq!(frame.code, Some(7));
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        host.open("persist"),
        generation,
        "reopening an exited session must not launch a new shell"
    );
}

#[cfg(unix)]
#[test]
fn unattended_output_does_not_block_and_close_only_ends_its_session() {
    let mut host = RunningHost::new();
    let first = host.open("flood");
    let second = host.open("other");
    host.write(
        "flood",
        &first,
        "yes 'background output 中文' | head -n 70000; printf 'flood-complete\\n' > complete.txt\n",
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    while !host.directory.join("complete.txt").exists() {
        assert!(Instant::now() < deadline, "unattended output blocked");
        std::thread::sleep(Duration::from_millis(50));
    }
    let frame = host.read("flood", &first, Some(0));
    assert!(frame.reset, "lagging clients receive a bounded snapshot");
    assert!(frame.data.len() < 1024 * 1024);
    host.client
        .request(Operation::Close {
            id: "flood".into(),
            generation: first,
        })
        .expect("close");
    host.write("other", &second, "printf 'other-alive\\n'\n");
    host.until("other", &second, "other-alive");
}

#[cfg(unix)]
#[test]
fn client_process_exit_keeps_shell_and_background_work_alive() {
    const CHILD_DIRECTORY: &str = "UTERM_TEST_CLIENT_STATE";
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        let directory = PathBuf::from(directory);
        let client = ensure_running(
            &directory,
            std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
        )
        .expect("child starts host");
        let spec = SessionSpec {
            id: "parent-exit".into(),
            directory: directory.clone(),
            shell: "default".into(),
            agent: None,
        };
        let Reply::Opened { generation } = client
            .request(Operation::Open {
                spec,
                rows: 24,
                cols: 80,
            })
            .expect("open")
        else {
            panic!("open reply")
        };
        client.request(Operation::Write { id: "parent-exit".into(), generation: generation.clone(), data: b"export UTERM_PARENT_EXIT=kept; sleep 1; printf 'continued-after-client-exit\\n' > background.txt\n".to_vec() }).expect("launch background task");
        std::fs::write(directory.join("generation.txt"), generation).expect("save generation");
        return;
    }
    let directory =
        std::env::temp_dir().join(format!("uterm-client-exit-{}", uuid::Uuid::new_v4()));
    let status = std::process::Command::new(std::env::current_exe().expect("test executable"))
        .args([
            "--exact",
            "client_process_exit_keeps_shell_and_background_work_alive",
            "--nocapture",
        ])
        .env(CHILD_DIRECTORY, &directory)
        .status()
        .expect("child client");
    assert!(status.success());
    let client = Client::connect(&directory).expect("host survives parent process exit");
    let generation = std::fs::read_to_string(directory.join("generation.txt")).expect("generation");
    let host = RunningHost {
        directory,
        client,
        sessions: vec![("parent-exit".into(), generation.clone())],
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !host.directory.join("background.txt").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(50));
    }
    host.write(
        "parent-exit",
        &generation,
        "printf 'retained:%s\\n' \"$UTERM_PARENT_EXIT\"\n",
    );
    host.until("parent-exit", &generation, "retained:kept");
}

#[cfg(unix)]
#[test]
fn terminal_queries_are_answered_without_a_connected_renderer() {
    let mut host = RunningHost::new();
    let generation = host.open("query");
    host.write("query", &generation, "stty -echo -icanon min 0 time 20; printf '\\033[6n'; dd bs=1 count=8 2>/dev/null > reply.txt; stty sane; printf 'query-finished\\n' > query-done.txt\n");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !host.directory.join("query-done.txt").exists() {
        assert!(Instant::now() < deadline, "query blocked without renderer");
        std::thread::sleep(Duration::from_millis(50));
    }
    let reply = std::fs::read(host.directory.join("reply.txt")).expect("query response");
    assert!(reply.starts_with(b"\x1b["));
    assert!(reply.contains(&b'R'), "{reply:?}");
}

#[test]
fn connection_waits_for_delayed_request_bytes() {
    use std::io::{Read, Write};
    let host = RunningHost::new();
    let endpoint: serde_json::Value = serde_json::from_slice(
        &std::fs::read(host.directory.join("endpoint.json")).expect("endpoint"),
    )
    .expect("endpoint JSON");
    let mut stream = std::net::TcpStream::connect((
        "127.0.0.1",
        endpoint["port"].as_u64().expect("port") as u16,
    ))
    .expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("timeout");
    // accept() inherits O_NONBLOCK on macOS; the server must wait for request bytes.
    // macOS 的 accept() 会继承 O_NONBLOCK；服务端必须等待请求字节到达。
    std::thread::sleep(Duration::from_millis(100));
    let request = serde_json::to_vec(&serde_json::json!({
        "version": 1, "token": endpoint["token"], "operation": "Ping"
    }))
    .expect("request");
    stream
        .write_all(&(request.len() as u32).to_be_bytes())
        .expect("length");
    std::thread::sleep(Duration::from_millis(50));
    stream.write_all(&request).expect("body");
    let mut length = [0; 4];
    stream.read_exact(&mut length).expect("response length");
    let mut response = vec![0; u32::from_be_bytes(length) as usize];
    stream.read_exact(&mut response).expect("response");
    assert!(matches!(
        serde_json::from_slice::<Reply>(&response).expect("reply"),
        Reply::Ready { .. }
    ));
}

#[test]
fn agent_reports_survive_reattachment_and_reject_stale_generations() {
    let mut host = RunningHost::new();
    let generation = host.open("agent-reports");
    for state in ["working", "waiting", "done"] {
        host.client
            .request(Operation::Report {
                id: "agent-reports".into(),
                generation: generation.clone(),
                state: state.into(),
            })
            .expect("report");
        let restored = Client::connect(&host.directory).expect("reattach");
        match restored
            .request(Operation::Read {
                id: "agent-reports".into(),
                generation: generation.clone(),
                after: None,
            })
            .expect("read")
        {
            Reply::Frame(frame) => assert_eq!(frame.agent_state.as_deref(), Some(state)),
            reply => panic!("{reply:?}"),
        }
    }
    assert!(host
        .client
        .request(Operation::Report {
            id: "agent-reports".into(),
            generation: "stale".into(),
            state: "working".into()
        })
        .is_err());
    assert!(host
        .client
        .request(Operation::Report {
            id: "agent-reports".into(),
            generation,
            state: "invalid".into()
        })
        .is_err());
}

#[cfg(unix)]
#[test]
fn custom_agent_arguments_and_reporter_environment_reach_the_daemon() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("uterm-custom-agent-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("root");
    let program = root.join("custom agent.sh");
    std::fs::write(&program, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n\"$UTERM_DESKTOP_REPORTER\" --agent-report done </dev/null\nsleep 20\n").expect("program");
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).expect("executable");
    let definitions = serde_json::json!([{"id":"custom","name":"Custom","program":program,"arguments":["argument with spaces", "$(echo not-executed)"]}]);
    std::fs::write(
        root.join("agents.json"),
        serde_json::to_vec(&definitions).expect("JSON"),
    )
    .expect("config");
    let directory = root.join("host");
    let client = ensure_running(
        &directory,
        std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
    )
    .expect("host");
    client.require_agent_support().expect("agent support");
    let Reply::Opened { generation } = client
        .request(Operation::Open {
            spec: SessionSpec {
                id: "custom-session".into(),
                directory: root.clone(),
                shell: "default".into(),
                agent: Some("custom".into()),
            },
            rows: 24,
            cols: 80,
        })
        .expect("open")
    else {
        panic!("opened");
    };
    let host = RunningHost {
        directory,
        client,
        sessions: vec![("custom-session".into(), generation.clone())],
    };
    let frame = host.until("custom-session", &generation, "$(echo not-executed)");
    assert!(String::from_utf8_lossy(&frame.data).contains("argument with spaces"));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if host
            .read("custom-session", &generation, None)
            .agent_state
            .as_deref()
            == Some("done")
        {
            break;
        }
        assert!(Instant::now() < deadline, "reporter did not reach daemon");
        std::thread::sleep(Duration::from_millis(25));
    }
    drop(host);
    std::fs::remove_dir_all(root).expect("cleanup");
}

#[cfg(unix)]
#[test]
fn alternate_screen_and_resize_survive_renderer_reattachment() {
    let mut host = RunningHost::new();
    let generation = host.open("full-screen");
    host.write(
        "full-screen",
        &generation,
        "stty -echo; touch screen-ready.txt\n",
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !host.directory.join("screen-ready.txt").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(25));
    }
    host.write("full-screen", &generation, "printf '\\033[?1049h\\033[2J\\033[5;8Hfullscreen-marker'; sleep 2; printf '\\033[?1049l'\n");
    let frame = host.until("full-screen", &generation, "fullscreen-marker");
    assert!(frame.data.windows(8).any(|part| part == b"\x1b[?1049h"));
    host.client
        .request(Operation::Resize {
            id: "full-screen".into(),
            generation: generation.clone(),
            rows: 30,
            cols: 100,
        })
        .expect("resize");
    let resized = host.read("full-screen", &generation, None);
    assert_eq!((resized.rows, resized.cols), (30, 100));
}

#[test]
fn update_preflight_rejects_unmanaged_and_unreachable_hosts_without_stopping_sessions() {
    use utermd_local::daemon::ensure_update_safe;
    let mut host = RunningHost::new();
    let generation = host.open("update-guard");
    assert!(ensure_update_safe(&host.directory).is_err());
    assert_eq!(host.open("update-guard"), generation);
    let endpoint = host.directory.join("endpoint.json");
    let original = std::fs::read(&endpoint).expect("read endpoint");
    std::fs::write(&endpoint, b"invalid").expect("corrupt endpoint");
    assert!(ensure_update_safe(&host.directory).is_err());
    std::fs::write(endpoint, original).expect("restore endpoint");
    assert_eq!(host.open("update-guard"), generation);
}

#[test]
fn detached_host_allows_updates_and_survives_installation_replacement() {
    use utermd_local::daemon::ensure_update_safe;
    let root = std::env::temp_dir().join(format!("uterm-update-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("root");
    let installed = root.join(if cfg!(windows) { "uTerm.exe" } else { "uTerm" });
    let detached = root.join(if cfg!(windows) {
        "uterm-session-host.exe"
    } else {
        "uterm-session-host"
    });
    std::fs::copy(env!("CARGO_BIN_EXE_utermd-local"), &installed).expect("install");
    std::fs::copy(&installed, &detached).expect("detach executable");
    let directory = root.join("state");
    ensure_update_safe(&directory).expect("no host");
    let client = ensure_running(&directory, &detached).expect("host");
    let mut host = RunningHost {
        directory,
        client,
        sessions: vec![],
    };
    let generation = host.open("update-session");
    ensure_update_safe(&host.directory).expect("detached host is safe");
    std::fs::remove_file(&installed).expect("remove old installation");
    std::fs::write(&installed, b"new app version").expect("replace installation");
    host.client = Client::connect(&host.directory).expect("reconnect after update");
    assert_eq!(host.open("update-session"), generation);
    #[cfg(unix)]
    {
        host.write(
            "update-session",
            &generation,
            "printf 'alive-after-update\\n'\n",
        );
        host.until("update-session", &generation, "alive-after-update");
    }
    drop(host);
    let deadline = Instant::now() + Duration::from_secs(5);
    while let Err(error) = std::fs::remove_dir_all(&root) {
        assert!(Instant::now() < deadline, "cleanup: {error}");
        std::thread::sleep(Duration::from_millis(50));
    }
}
