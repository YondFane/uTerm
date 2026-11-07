use super::{call, helper, HostCleanup};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
use uterm_core::Core;
use utermd_local::daemon::{Client, Operation, Reply};

fn copy_fixture(source: &Path, destination: &Path) {
    std::fs::create_dir_all(destination).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = destination.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_fixture(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

#[test]
#[ignore = "Requires Maven and real Maven Central dependencies; executed by Maven interoperability CI"]
fn real_maven_reactor_and_spring_boot_use_shared_task_lifetimes() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().canonicalize().unwrap();
    let root = data.join("Maven reactor & percent %");
    copy_fixture(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/maven-live"),
        &root,
    );
    std::fs::create_dir(root.join(".mvn")).unwrap();
    std::fs::write(
        root.join(".mvn/jvm.config"),
        "-Dqa.maven.flag=jvm-selected\n",
    )
    .unwrap();
    let settings = data.join("Maven settings & percent %.xml");
    let extra_settings = std::env::var("UTERM_MAVEN_QA_SETTINGS_XML").unwrap_or_default();
    std::fs::write(&settings,format!(r#"<settings>{extra_settings}<profiles><profile><id>qa-settings</id><properties><qa.settings>settings-selected</qa.settings></properties></profile></profiles><activeProfiles><activeProfile>qa-settings</activeProfile></activeProfiles></settings>"#)).unwrap();
    let java_home = PathBuf::from(std::env::var_os("JAVA_HOME").expect("JAVA_HOME is required"));
    let maven_home =
        PathBuf::from(std::env::var_os("UTERM_MAVEN_HOME").expect("UTERM_MAVEN_HOME is required"));
    let repository = std::env::var_os("UTERM_MAVEN_REPOSITORY")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.join("Maven repository & percent %"));
    let core = Core::open(data.join("shared-state-v1")).unwrap();
    let host_root = data.join("local-daemon-v1");
    let _cleanup = HostCleanup(host_root.clone());
    call(&core, "host.configure", json!({"helper":helper()}));
    let (send, receive) = mpsc::channel();
    core.set_terminal_sink(Arc::new(move |_, generation, frame| {
        send.send((generation.to_owned(), frame))
            .map_err(|error| error.to_string())
    }))
    .unwrap();
    let mut config =
        call(&core, "java.configuration", json!({"directory":root}))["project"].clone();
    config["java_home"] = json!(java_home);
    config["java_version"] = json!(uterm_core::java::probe(&java_home).unwrap().version);
    config["maven_scope"] = json!("project");
    config["maven_configured"] = json!(true);
    config["maven"] = json!({"distribution":"local","home":uterm_core::java::path_text(&maven_home),"settings":uterm_core::java::path_text(&settings),"repository":uterm_core::java::path_text(&repository),"wrapper":false});
    config["module"] = json!("app");
    config["maven_profiles"] = json!("qa");
    config["spring_profiles"] = json!("qa");
    config["vm_arguments"] = json!([r#"-Dqa.value=VM & %PATH% " ' C:\path\"#]);
    config["arguments"] = json!([""]);
    let refused = core.execute(&serde_json::to_vec(&json!({"version":1,"id":"refuse-lossy-development","method":"java.start","params":{"directory":root,"action":"run","config":config,"environment":{}}})).unwrap());
    assert_eq!(
        refused.error.unwrap().code,
        "JAVA_DEVELOPMENT_ARGUMENTS_UNSUPPORTED"
    );
    assert!(
        !host_root.join("endpoint.json").exists(),
        "Lossy arguments must be rejected before starting a host"
    );
    let literal = r#"literal & %PATH% * " ' C:\path with spaces\"#;
    config["arguments"] = json!([literal]);
    let start = |config: &Value, action: &str| {
        call(
            &core,
            "java.start",
            json!({"directory":root,"action":action,"config":config,"environment":{"VALUE":"ENV & %PATH%"}}),
        )
    };
    let open = |task: &Value| {
        for _ in receive.try_iter() {}
        let reply = call(
            &core,
            "terminal.open",
            json!({"id":task["spec"]["id"],"attachment":"maven-live","directory":root,"shell":"default","rows":30,"cols":160,"taskOnly":true}),
        );
        assert_eq!(reply["generation"], task["generation"]);
    };
    let collect = |task: &Value, marker: Option<&str>| {
        let deadline = Instant::now() + Duration::from_secs(240);
        let mut bytes = Vec::new();
        let mut sequences = Vec::new();
        loop {
            let (generation, frame) = receive
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|error| {
                    panic!(
                        "Maven output for task {} generation {}: {error}; last output: {}",
                        task["spec"]["id"],
                        task["generation"],
                        String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(64 * 1024)..])
                    )
                });
            assert_eq!(generation, task["generation"].as_str().unwrap());
            if let Some(previous) = sequences.last() {
                assert!(frame.sequence >= *previous);
            }
            sequences.push(frame.sequence);
            bytes.extend_from_slice(&frame.data);
            assert!(
                frame.error.is_none(),
                "Maven output transport for task {} generation {}: {:?}; last output: {}",
                task["spec"]["id"],
                task["generation"],
                frame.error,
                String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(64 * 1024)..])
            );
            assert!(
                bytes.len() <= 4 * 1024 * 1024,
                "Fixture output must stay bounded"
            );
            call(
                &core,
                "terminal.action",
                json!({"attachment":"maven-live","action":"ack","sequence":frame.sequence.to_string()}),
            );
            if frame.exited
                || marker.is_some_and(|marker| String::from_utf8_lossy(&bytes).contains(marker))
            {
                return (String::from_utf8(bytes).unwrap(), frame.code, sequences);
            }
        }
    };
    let detach = || {
        call(
            &core,
            "terminal.action",
            json!({"attachment":"maven-live","action":"detach"}),
        );
    };
    let mut stages = Vec::new();
    for action in ["build", "test", "install"] {
        let task = start(&config, action);
        open(&task);
        let (output, code, sequences) = collect(&task, None);
        assert_eq!(code, Some(0), "{action}: {output}");
        assert!(output.contains("BUILD SUCCESS"), "{output}");
        assert!(root
            .join("app/target/surefire-reports/TEST-qa.BoundaryTest.xml")
            .is_file());
        stages.push(json!({"action":action,"generation":task["generation"],"code":code,"output":output,"sequences":sequences.iter().map(u64::to_string).collect::<Vec<_>>() }));
        detach();
    }
    assert!(repository
        .join("qa/uterm/library/1.0/library-1.0.jar")
        .is_file());
    assert!(repository.join("qa/uterm/app/1.0/app-1.0.jar").is_file());
    for mode in ["development", "jar"] {
        config["mode"] = json!(mode);
        config["arguments"] = if mode == "jar" {
            json!([literal, ""])
        } else {
            json!([literal])
        };
        let task = start(&config, "run");
        open(&task);
        let (output, code, sequences) = collect(&task, None);
        assert_eq!(
            code,
            Some(0),
            "{mode}: {output}\nFixture's filtered arguments: {}",
            std::fs::read_to_string(root.join("app/target/classes/qa.properties"))
                .unwrap_or_default()
        );
        if cfg!(windows) && mode == "development" {
            assert!(
                std::fs::read_to_string(root.join("app/target/classes/qa.properties"))
                    .unwrap()
                    .contains("verifiedChildren=false")
            );
        }
        for marker in [
            r#"READY_MAVEN:from-reactor:ENV & %PATH%:VM & %PATH% " ' C:\path\"#,
            "PROFILES:qa",
            "MAVEN_FLAGS:profile-selected:settings-selected:jvm-selected",
            "FINAL_MAVEN:中文 e\u{301}",
            "FINAL_MAVEN_ERR:中文",
        ] {
            assert!(output.contains(marker), "Missing {marker}: {output}");
        }
        assert!(output.contains(&format!("ARG:{literal}:END")), "{output}");
        if mode == "jar" {
            assert!(output.contains("ARG::END"), "{output}");
        }
        stages.push(json!({"action":mode,"generation":task["generation"],"code":code,"output":output,"sequences":sequences.iter().map(u64::to_string).collect::<Vec<_>>() }));
        detach();
    }
    config["maven_profiles"] = json!("qa,broken");
    let failed = start(&config, "test");
    open(&failed);
    let (output, code, _) = collect(&failed, None);
    assert_ne!(
        code,
        Some(0),
        "The real failing test must fail the task: {output}"
    );
    assert!(output.contains("BUILD FAILURE"), "{output}");
    stages.push(json!({"action":"expected-test-failure","generation":failed["generation"],"code":code,"output":output}));
    detach();
    config["maven_profiles"] = json!("qa");
    let retried = start(&config, "test");
    open(&retried);
    let (output, code, _) = collect(&retried, None);
    assert_eq!(code, Some(0), "Explicit test retry: {output}");
    assert_ne!(retried["generation"], failed["generation"]);
    stages.push(json!({"action":"explicit-test-retry","generation":retried["generation"],"code":code,"output":output}));
    detach();
    let client = Client::connect(&host_root).unwrap();
    config["jar"] = json!("app/target/app-1.0.jar");
    config["arguments"] = json!(["wait"]);
    let live = start(&config, "run");
    open(&live);
    let (initial, _, _) = collect(&live, Some("READY_MAVEN:"));
    let pid = super::status(&client).pid;
    detach();
    assert!(
        matches!(client.request(Operation::TaskSnapshot).unwrap(),Reply::Tasks(tasks) if tasks.iter().any(|task|task.spec.id==live["spec"]["id"].as_str().unwrap() && task.running))
    );
    open(&live);
    let (replay, _, _) = collect(&live, Some("READY_MAVEN:"));
    assert!(initial.contains("READY_MAVEN:") && replay.contains("READY_MAVEN:"));
    assert_eq!(super::status(&client).pid, pid);
    let rejected=core.execute(&serde_json::to_vec(&json!({"version":1,"id":"stale-maven-stop","method":"java.stop","params":{"id":live["spec"]["id"],"generation":"stale","force":true}})).unwrap());
    assert_eq!(rejected.error.unwrap().code, "JAVA_TASK_REPLACED");
    call(
        &core,
        "java.stop",
        json!({"id":live["spec"]["id"],"generation":live["generation"],"force":false}),
    );
    let (output, code, _) = collect(&live, None);
    assert!(
        output.contains("STOP_MAVEN_CLEANUP"),
        "Graceful stop lost the real Spring Boot shutdown hook: {output}"
    );
    stages.push(json!({"action":"detach-replay-and-graceful-stop","generation":live["generation"],"code":code,"initial":initial,"replay":replay,"output":output,"sameHostPID":pid}));
    detach();
    assert!(
        matches!(client.request(Operation::TaskSnapshot).unwrap(),Reply::Tasks(tasks) if tasks.iter().all(|task|!task.running))
    );
    core.close();
    client.request(Operation::ShutdownIfIdle).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while host_root.join("endpoint.json").exists() {
        assert!(Instant::now() < deadline, "Maven host did not clean up");
        std::thread::sleep(Duration::from_millis(25));
    }
    if let Some(path) = std::env::var_os("UTERM_MAVEN_CORE_REPORT") {
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(env!("CARGO_MANIFEST_DIR"))
                .output()
                .unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        let tested = git(&["rev-parse", "HEAD"]);
        std::fs::write(path,serde_json::to_vec_pretty(&json!({"passed":true,"sourceHeadSHA":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_|tested.clone()),"testedMergeSHA":tested,"sourceTreeDirty":!git(&["status","--porcelain","--untracked-files=no"]).is_empty(),"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"javaMajor":config["java_version"],"springBoot":"2.7.18","multiModuleBuildTestInstall":true,"developmentAndPackagedRun":true,"settingsProfilesJvmConfigAndLiteralArguments":true,"emptyJarArgumentPreserved":true,"lossyDevelopmentArgumentsRefusedBeforeHostStarted":true,"detachReattachRetainedHostAndGeneration":true,"staleStopRefused":true,"gracefulStopRetainedFinalOutput":true,"explicitRetryAfterRealTestFailure":true,"allTasksExited":true,"hostCleanedUp":true,"guiAcceptance":false,"stages":stages})).unwrap()).unwrap();
    }
}
