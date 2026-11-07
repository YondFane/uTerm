use super::*;

#[test]
fn simulated_agent_cli_preserves_input_replay_recovery_and_exact_close() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let host_root = root.join("local-daemon-v1");
    let _cleanup = HostCleanup(host_root.clone());
    let python = std::process::Command::new(if cfg!(windows) { "python" } else { "python3" })
        .args(["-I", "-c", "import json,sys; print(json.dumps({'executable':sys.executable,'version':sys.version}))"])
        .output()
        .unwrap();
    assert!(python.status.success());
    let runtime: Value = serde_json::from_slice(&python.stdout).unwrap();
    let interpreter = runtime["executable"].as_str().unwrap();
    let script = root.join("mock agent 中文.py");
    std::fs::write(
        &script,
        include_bytes!("../../../../shared/fixtures/m2-agent-cli.py"),
    )
    .unwrap();
    let literal = "literal argument 中文 & %PATH% $(not-executed)";
    std::fs::write(
        root.join("agents.json"),
        serde_json::to_vec(&json!([{
            "id":"m2-qa-agent","name":"M2 simulated Agent CLI","program":interpreter,
        "arguments":["-I","-u","-X","utf8",script,literal,""]
        }]))
        .unwrap(),
    )
    .unwrap();
    let open = |attachment: &str, reconnect: bool| {
        json!({
            "id":"m2-simulated-agent","attachment":attachment,"directory":root,
            "shell":"default","agent":"m2-qa-agent","rows":30,"cols":100,"reconnectOnly":reconnect
        })
    };
    let attach = |core: &Core| {
        call(core, "host.configure", json!({"helper":helper()}));
        let (send, receive) = mpsc::channel();
        core.set_terminal_sink(Arc::new(move |_, generation, frame| {
            send.send((generation.to_owned(), frame))
                .map_err(|error| error.to_string())
        }))
        .unwrap();
        receive
    };
    let first = Core::open(root.join("shared-state-v1")).unwrap();
    let receive = attach(&first);
    let generation = call(&first, "terminal.open", open("mock-before-pause", false))["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    let consume = |core: &Core,
                   receive: &mpsc::Receiver<(String, utermd_local::daemon::Frame)>,
                   attachment: &str,
                   marker: &str| {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut bytes = vec![];
        let mut previous = 0;
        loop {
            let (actual, frame) = receive
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|error| panic!("Mock CLI did not produce {marker}: {error:?}"));
            assert_eq!(actual, generation);
            assert!(frame.error.is_none(), "{:?}", frame.error);
            assert!(frame.sequence >= previous);
            previous = frame.sequence;
            bytes.extend_from_slice(&frame.data);
            call(
                core,
                "terminal.action",
                json!({"attachment":attachment,"action":"ack","sequence":frame.sequence.to_string()}),
            );
            if String::from_utf8_lossy(&bytes).contains(marker) {
                return (frame, bytes);
            }
            assert!(!frame.exited, "Mock CLI exited before {marker}");
        }
    };
    let (_, ready) = consume(&first, &receive, "mock-before-pause", "MOCK_AGENT_READY");
    assert!(ready
        .windows(b"\x1b[?1049h".len())
        .any(|part| part == b"\x1b[?1049h"));
    let args: Vec<String> =
        serde_json::from_slice(&std::fs::read(root.join("mock-arguments.json")).unwrap()).unwrap();
    assert_eq!(args, [literal, ""]);
    let observer = Client::connect(&host_root).unwrap();
    let pid = status(&observer).pid;
    let newline = if cfg!(windows) { "\r" } else { "\n" };
    let text = "模拟任务一 中文 e\u{301} 😀";
    first
        .terminal_write(
            "mock-before-pause",
            format!("\x1b[200~{text}\x1b[201~{newline}").as_bytes(),
        )
        .unwrap();
    consume(&first, &receive, "mock-before-pause", "MOCK_AGENT_TURN_1:");
    assert_eq!(
        std::fs::read(root.join("mock-turn-1.txt")).unwrap(),
        text.as_bytes()
    );
    first.close();
    while receive.try_recv().is_ok() {}
    assert!(receive.recv_timeout(Duration::from_millis(50)).is_err());
    assert!(first
        .terminal_write("mock-before-pause", b"STALE_INPUT\n")
        .is_err());
    let retained = status(&observer);
    assert_eq!(retained.pid, pid);
    assert!(retained
        .sessions
        .iter()
        .any(|session| session.spec.id == "m2-simulated-agent"
            && session.running
            && session.generation == generation));
    let second = Core::open(root.join("shared-state-v1")).unwrap();
    let resumed = attach(&second);
    assert_eq!(
        call(&second, "terminal.open", open("mock-after-pause", true))["generation"],
        generation
    );
    let (replay, _) = consume(&second, &resumed, "mock-after-pause", "MOCK_AGENT_TURN_1:");
    assert!(replay.reset);
    second
        .terminal_write("mock-after-pause", format!("/error{newline}").as_bytes())
        .unwrap();
    consume(
        &second,
        &resumed,
        "mock-after-pause",
        "MOCK_AGENT_RETRYABLE_ERROR",
    );
    let next = "literal C:\\path\\ & %PATH% $(not-executed)";
    second
        .terminal_write("mock-after-pause", format!("{next}{newline}").as_bytes())
        .unwrap();
    consume(&second, &resumed, "mock-after-pause", "MOCK_AGENT_TURN_2:");
    assert_eq!(
        std::fs::read(root.join("mock-turn-2.txt")).unwrap(),
        next.as_bytes()
    );
    assert!(!root.join("mock-turn-3.txt").exists());
    second
        .terminal_write("mock-after-pause", format!("/cancel{newline}").as_bytes())
        .unwrap();
    consume(
        &second,
        &resumed,
        "mock-after-pause",
        "MOCK_AGENT_CANCELLED",
    );
    assert_eq!(
        std::fs::read(root.join("mock-cancelled.txt")).unwrap(),
        b"cancelled"
    );
    second
        .terminal_write("mock-after-pause", format!("/quit{newline}").as_bytes())
        .unwrap();
    let (mut final_frame, exit_output) =
        consume(&second, &resumed, "mock-after-pause", "MOCK_AGENT_EXIT");
    assert!(exit_output
        .windows(b"\x1b[?1049l".len())
        .any(|part| part == b"\x1b[?1049l"));
    while !final_frame.exited {
        let (actual, frame) = resumed.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(actual, generation);
        call(
            &second,
            "terminal.action",
            json!({"attachment":"mock-after-pause","action":"ack","sequence":frame.sequence.to_string()}),
        );
        final_frame = frame;
    }
    assert_eq!(final_frame.code, Some(7));
    assert_eq!(status(&observer).pid, pid);
    call(
        &second,
        "terminal.action",
        json!({"attachment":"mock-after-pause","action":"close"}),
    );
    assert!(!status(&observer)
        .sessions
        .iter()
        .any(|session| session.spec.id == "m2-simulated-agent"));
    second.close();
    if let Some(path) = std::env::var_os("UTERM_M2_SIMULATION_REPORT") {
        let git = |args: &[&str]| {
            let result = std::process::Command::new("git")
                .args(args)
                .current_dir(env!("CARGO_MANIFEST_DIR"))
                .output()
                .unwrap();
            assert!(result.status.success());
            String::from_utf8(result.stdout).unwrap().trim().to_owned()
        };
        let tested = git(&["rev-parse", "HEAD"]);
        std::fs::write(path, serde_json::to_vec_pretty(&json!({
            "passed":true,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
            "sourceHeadSHA":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_|tested.clone()),
            "testedMergeSHA":tested,"sourceTreeDirty":!git(&["status","--porcelain","--untracked-files=no"]).is_empty(),
            "mockAgentCLI":true,"actualAgentProvider":false,"actualOSPowerSleep":false,
            "hostPID":pid,"generation":generation,"mockTurns":2,"exitCode":7,
            "pythonVersion":runtime["version"],
            "firstTurnUTF8Bytes":text.len(),"secondTurnUTF8Bytes":next.len(),
            "rawTerminalBytes":true,"alternateScreenReturned":true,
            "actualHostAndPTY":true,"literalArguments":true,"emptyArgument":true,"unicodeBracketedPaste":true,
            "twoMockTurns":true,"simulatedSuspendViaDetach":true,"sameHostAndGeneration":true,
            "replayedPriorOutput":true,"staleInputRejected":true,"mockErrorRecovered":true,
            "mockCancelHandled":true,"exactFinalOutputAndExitCode":true,"callbacksStoppedOnClose":true,
            "exactClose":true,"realAccountUsed":false,"guiAcceptance":false
        })).unwrap()).unwrap();
    }
}
