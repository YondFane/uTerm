use super::*;

#[test]
fn installed_hook_process_reports_real_activity_and_rejects_stale_generation() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let host = root.join("local-daemon-v1");
    let _cleanup = HostCleanup(host.clone());
    let core = Core::open(root.join("shared-state-v1")).unwrap();
    call(&core, "host.configure", json!({"helper":helper()}));
    let home = root.join("private-agent-home");
    call(&core, "agent.configure", json!({"home":home}));
    call(&core, "agent.catalog", Value::Null);
    assert!(!home.exists());
    call(
        &core,
        "agent.hooks",
        json!({"agent":"copilot","enabled":true}),
    );
    let path = home.join(".copilot/hooks/uterm-activity.json");
    let config: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    core.set_terminal_sink(Arc::new(|_, _, _| Ok(()))).unwrap();
    let generation = call(
        &core,
        "terminal.open",
        json!({"id":"hook-process","attachment":"hook-test","directory":root,"shell":"default","rows":24,"cols":80}),
    )["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    let run = |event: &str, generation: &str| {
        let hook = &config["hooks"][event][0];
        let mut command = std::process::Command::new(hook["exec"].as_str().unwrap());
        command.args(
            hook["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap()),
        );
        command
            .env("UTERM_DESKTOP_HOST", &host)
            .env("UTERM_DESKTOP_SESSION", "hook-process")
            .env("UTERM_DESKTOP_GENERATION", generation);
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = command.spawn().unwrap();
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&vec![b'x'; 64 * 1024])
            .unwrap();
        child.wait_with_output().unwrap()
    };
    let client = Client::connect(&host).unwrap();
    let Reply::Frame(baseline) = client
        .request(Operation::Read {
            id: "hook-process".into(),
            generation: generation.clone(),
            after: None,
        })
        .unwrap()
    else {
        panic!("Expected initial frame")
    };
    let mut cursor = baseline.sequence;
    for (event, state) in [("userPromptSubmitted", "working"), ("agentStop", "done")] {
        let result = run(event, &generation);
        assert!(
            result.status.success(),
            "{event}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let Reply::Frame(frame) = client
            .request(Operation::Read {
                id: "hook-process".into(),
                generation: generation.clone(),
                after: Some(cursor),
            })
            .unwrap()
        else {
            panic!("Expected frame")
        };
        assert_eq!(frame.agent_state.as_deref(), Some(state));
        assert!(frame
            .agent_events
            .as_ref()
            .unwrap()
            .iter()
            .any(|event| event.kind == state));
        cursor = frame.sequence;
    }
    assert!(!run("userPromptSubmitted", "stale-generation")
        .status
        .success());
    call(
        &core,
        "agent.hooks",
        json!({"agent":"copilot","enabled":false}),
    );
    let removed: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert!(removed["hooks"]
        .as_object()
        .unwrap()
        .values()
        .all(|events| events.as_array().unwrap().is_empty()));
    core.close();
    drop(_cleanup);
    assert!(!host.join("endpoint.json").exists());
    if let Some(report) = std::env::var_os("UTERM_AGENT_CORE_REPORT") {
        let git = |arguments: &[&str]| {
            String::from_utf8(
                std::process::Command::new("git")
                    .args(arguments)
                    .output()
                    .unwrap()
                    .stdout,
            )
            .unwrap()
            .trim()
            .to_owned()
        };
        let tested = git(&["rev-parse", "HEAD"]);
        std::fs::write(report, serde_json::to_vec_pretty(&json!({
            "installedReporterProcess":true,"largeStdinDrained":true,"workingAndDoneEvents":true,
            "staleGenerationRejected":true,"privateHomeOnly":true,"actualAgentProvider":false,
            "providerAuthentication":"not executed; simulated provider boundary authorized",
            "ownedHostStopped":true,"passed":true,"sourceHeadSHA":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_| tested.clone()),
            "testedMergeSHA":tested,"sourceTreeDirty":!git(&["status","--porcelain","--untracked-files=no"]).is_empty(),
            "platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
            "rust":String::from_utf8(std::process::Command::new("rustc").arg("--version").output().unwrap().stdout).unwrap().trim()
        })).unwrap()).unwrap();
    }
}

#[test]
fn agent_platform_configuration_and_notification_preferences_keep_legacy_defaults() {
    let temporary = tempfile::tempdir().unwrap();
    let core = Core::open(temporary.path().join("shared-state-v1")).unwrap();
    call(&core, "host.configure", json!({"helper":helper()}));
    for params in [
        json!({"home":"relative"}),
        json!({"home":temporary.path(),"credential":"private-secret"}),
    ] {
        let response = core.execute(
            &serde_json::to_vec(
                &json!({"version":1,"id":"bad-agent","method":"agent.configure","params":params}),
            )
            .unwrap(),
        );
        let error = response.error.unwrap();
        assert_eq!(error.code, "AGENT_INVALID_PARAMS");
        assert!(!error.message.contains("private-secret"));
    }
    call(
        &core,
        "agent.configure",
        json!({"home":temporary.path().join("private-home")}),
    );
    let defaults = call(&core, "state.defaults", Value::Null);
    let mut settings = defaults["settings"].clone();
    assert!(settings.get("agentNotifications").is_none());
    uterm_core::state::validate_settings(&settings).unwrap();
    settings["agentNotifications"] = json!(true);
    uterm_core::state::validate_settings(&settings).unwrap();
    settings["agentNotifications"] = json!("true");
    assert!(uterm_core::state::validate_settings(&settings).is_err());
    settings
        .as_object_mut()
        .unwrap()
        .remove("agentNotifications");
    settings["unknownSetting"] = json!(false);
    assert!(uterm_core::state::validate_settings(&settings).is_err());
}
