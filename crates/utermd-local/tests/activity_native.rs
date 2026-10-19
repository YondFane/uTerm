use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use utermd_local::daemon::{ensure_running, Client, Frame, Operation, Reply, SessionSpec};

struct Fixture {
    root: std::path::PathBuf,
    client: Client,
    generation: Option<String>,
    stop: Arc<AtomicBool>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(generation) = &self.generation {
            let _ = self.client.request(Operation::Close {
                id: "codex".into(),
                generation: generation.clone(),
            });
        }
        let _ = self.client.request(Operation::ShutdownIfEmpty);
        self.stop.store(true, Ordering::Release);
    }
}

#[test]
#[ignore = "Runs the installed Codex TUI against an isolated loopback model fixture"]
fn installed_codex_reports_two_turns_without_hooks() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/native-activity")
        .join(uuid::Uuid::new_v4().to_string());
    let workspace = root.join("workspace");
    let home = root.join("codex-home");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    std::thread::spawn(move || {
        while !stopping.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    std::thread::spawn(move || {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let mut headers = Vec::new();
                        let mut byte = [0];
                        while headers.len() < 65_536 && !headers.ends_with(b"\r\n\r\n") {
                            if stream.read_exact(&mut byte).is_err() {
                                return;
                            }
                            headers.push(byte[0]);
                        }
                        let headers = String::from_utf8_lossy(&headers);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.split_once(':')
                                    .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                                    .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if length > 2 * 1024 * 1024 {
                            return;
                        }
                        let mut body = vec![0; length];
                        if stream.read_exact(&mut body).is_err() {
                            return;
                        }
                        let item = serde_json::json!({"type":"message","id":"qa-message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"QA task finished."}]});
                        let mut events = String::new();
                        for event in [
                            serde_json::json!({"type":"response.created","response":{"id":"qa-response"}}),
                            serde_json::json!({"type":"response.output_item.done","output_index":0,"item":item}),
                            serde_json::json!({"type":"response.completed","response":{"id":"qa-response","status":"completed","output":[item],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}),
                        ] {
                            events.push_str(&format!("data: {event}\n\n"));
                        }
                        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{events}", events.len());
                        let _ = stream.write_all(response.as_bytes());
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(_) => break,
            }
        }
    });
    std::fs::write(home.join("config.toml"), format!(
        "model = \"qa\"\nmodel_provider = \"fixture\"\napproval_policy = \"never\"\nsandbox_mode = \"read-only\"\n[model_providers.fixture]\nname = \"QA fixture\"\nbase_url = \"http://{address}/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = false\n[projects.{}]\ntrust_level = \"trusted\"\n",
        serde_json::to_string(&workspace.to_string_lossy()).unwrap())).unwrap();
    // This ignored test owns its process and a fresh home; installed credentials are never used.
    // 此忽略测试独占测试进程并使用全新目录，不使用安装版凭证。
    std::env::set_var("CODEX_HOME", &home);
    let client = ensure_running(
        &root.join("host"),
        std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
    )
    .unwrap();
    let mut fixture = Fixture {
        root,
        client,
        generation: None,
        stop,
    };
    let Reply::Opened { generation } = fixture
        .client
        .request(Operation::Open {
            spec: SessionSpec {
                id: "codex".into(),
                directory: workspace,
                shell: "default".into(),
                agent: Some("codex".into()),
                ssh: None,
            },
            rows: 30,
            cols: 100,
        })
        .unwrap()
    else {
        panic!("not opened")
    };
    fixture.generation = Some(generation.clone());
    let read = |after| -> Frame {
        match fixture
            .client
            .request(Operation::Read {
                id: "codex".into(),
                generation: generation.clone(),
                after,
            })
            .unwrap()
        {
            Reply::Frame(frame) => frame,
            other => panic!("{other:?}"),
        }
    };
    let mut cursor = 0;
    let mut text = String::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !text.contains("›") && !text.contains("Type a message") {
        let frame = read(Some(cursor));
        cursor = frame.sequence;
        text.push_str(&String::from_utf8_lossy(&frame.data));
        assert!(!frame.exited, "CLI exited: {text}");
        assert!(Instant::now() < deadline, "CLI not ready: {text}");
    }
    let mut completions = Vec::new();
    for turn in 0..2 {
        std::thread::sleep(Duration::from_millis(700));
        fixture
            .client
            .request(Operation::Write {
                id: "codex".into(),
                generation: generation.clone(),
                data: format!("Finish QA task {turn}.").into_bytes(),
            })
            .unwrap();
        std::thread::sleep(Duration::from_millis(250));
        fixture
            .client
            .request(Operation::Write {
                id: "codex".into(),
                generation: generation.clone(),
                data: vec![13],
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let frame = read(Some(cursor));
            cursor = frame.sequence;
            text.push_str(&String::from_utf8_lossy(&frame.data));
            if let Some(error) = frame.agent_activity_error {
                panic!("{error}\n{text}");
            }
            for event in frame.agent_events.unwrap_or_default() {
                if event.kind == "done" && event.source == "events" {
                    completions.push(event.id);
                }
            }
            if completions.len() > turn {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Missing completion {turn}: {text}"
            );
        }
    }
    assert_ne!(completions[0], completions[1]);
    fixture
        .client
        .request(Operation::Close {
            id: "codex".into(),
            generation,
        })
        .unwrap();
    fixture.generation = None;
    assert!(std::fs::read_dir(fixture.root.join("host"))
        .unwrap()
        .all(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_none_or(|extension| extension != "token")));
    println!(
        "Installed Codex: two authenticated event completions; isolated fixture: {}",
        fixture.root.display()
    );
}
