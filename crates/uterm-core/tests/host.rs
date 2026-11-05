use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
use uterm_core::Core;
use utermd_local::daemon::{Client, Operation, Reply};

#[path = "host/java_encoding.rs"]
mod java_encoding;
#[path = "host/m2_simulation.rs"]
mod m2_simulation;
#[path = "host/maven.rs"]
mod maven;

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
fn two_core_clients_handoff_input_without_stopping_replay_or_detached_processes() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let _cleanup = HostCleanup(root.join("local-daemon-v1"));
    let first = Core::open(root.join("shared-state-v1")).unwrap();
    let second = Core::open(root.join("shared-state-v1")).unwrap();
    for core in [&first, &second] {
        call(core, "host.configure", json!({"helper":helper()}));
    }
    let (a_send, a_receive) = mpsc::channel();
    let (b_send, b_receive) = mpsc::channel();
    first
        .set_terminal_sink(Arc::new(move |_, generation, frame| {
            a_send
                .send((generation.to_owned(), frame))
                .map_err(|e| e.to_string())
        }))
        .unwrap();
    second
        .set_terminal_sink(Arc::new(move |_, generation, frame| {
            b_send
                .send((generation.to_owned(), frame))
                .map_err(|e| e.to_string())
        }))
        .unwrap();
    let open = |attachment: &str| json!({"id":"shared-control","attachment":attachment,"directory":root,"shell":"default","rows":24,"cols":80});
    let generation = call(&first, "terminal.open", open("control-a"))["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    let wait_role = |core: &Core,
                     receive: &mpsc::Receiver<(String, utermd_local::daemon::Frame)>,
                     attachment: &str,
                     owned: bool| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let (actual, frame) = receive
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            assert_eq!(actual, generation);
            assert!(frame.error.is_none(), "{:?}", frame.error);
            call(
                core,
                "terminal.action",
                json!({"attachment":attachment,"action":"ack","sequence":frame.sequence.to_string()}),
            );
            if frame
                .input_control
                .as_ref()
                .is_some_and(|status| status.owned == owned)
            {
                break frame;
            }
        }
    };
    let a = wait_role(&first, &a_receive, "control-a", true);
    assert_eq!(
        call(&second, "terminal.open", open("control-b"))["generation"],
        generation
    );
    let b = wait_role(&second, &b_receive, "control-b", false);
    let denied = |core: &Core, attachment: &str| {
        let error = core
            .terminal_write(attachment, b"echo DENIED\n")
            .unwrap_err();
        assert!(
            error.message.contains("SESSION_CONTROL_REQUIRED"),
            "{error:?}"
        );
    };
    denied(&second, "control-b");
    call(
        &second,
        "terminal.action",
        json!({"attachment":"control-b","action":"takeControl","rows":34,"cols":109}),
    );
    let acquired = wait_role(&second, &b_receive, "control-b", true);
    let revoked = wait_role(&first, &a_receive, "control-a", false);
    denied(&first, "control-a");
    call(
        &first,
        "terminal.action",
        json!({"attachment":"control-a","action":"detach"}),
    );
    first.close();
    let observer = Client::connect(&root.join("local-daemon-v1")).unwrap();
    let before = status(&observer);
    assert!(before
        .sessions
        .iter()
        .any(|session| session.spec.id == "shared-control" && session.running));
    second
        .terminal_write(
            "control-b",
            if cfg!(windows) {
                b"echo HANDOFF_ACCEPTED > handoff.txt\r"
            } else {
                b"echo HANDOFF_ACCEPTED > handoff.txt\n"
            },
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("handoff.txt").exists() {
        assert!(
            Instant::now() < deadline,
            "The remaining Core client could not write to its real PTY"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    second.close();
    let reopened = Core::open(root.join("shared-state-v1")).unwrap();
    call(&reopened, "host.configure", json!({"helper":helper()}));
    let (c_send, c_receive) = mpsc::channel();
    reopened
        .set_terminal_sink(Arc::new(move |_, generation, frame| {
            c_send
                .send((generation.to_owned(), frame))
                .map_err(|e| e.to_string())
        }))
        .unwrap();
    assert_eq!(
        call(&reopened, "terminal.open", open("control-c"))["generation"],
        generation
    );
    let reattached = wait_role(&reopened, &c_receive, "control-c", true);
    assert_eq!(status(&observer).pid, before.pid);
    call(
        &reopened,
        "terminal.action",
        json!({"attachment":"control-c","action":"close"}),
    );
    assert!(!status(&observer)
        .sessions
        .iter()
        .any(|session| session.spec.id == "shared-control"));
    reopened.close();
    if let Some(path) = std::env::var_os("UTERM_INPUT_CONTROL_CORE_REPORT") {
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
        std::fs::write(path,serde_json::to_vec_pretty(&json!({"passed":true,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
            "sourceHeadSHA":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_|tested.clone()),"testedMergeSHA":tested,"sourceTreeDirty":!git(&["status","--porcelain","--untracked-files=no"]).is_empty(),
            "sameGeneration":generation,"frameSequences":[a.sequence.to_string(),b.sequence.to_string(),acquired.sequence.to_string(),revoked.sequence.to_string(),reattached.sequence.to_string()],
            "passiveWriteRejected":true,"explicitTakeoverUpdatedBothStreams":true,"oldOwnerWriteRejected":true,"oldDetachRetainedNewOwner":true,"realPTYWriteAfterPeerClosed":true,
            "reopenRetainedGenerationAndHost":true,"reopenAcquiredReleasedControl":true,"explicitCloseTerminatedTarget":true})).unwrap()).unwrap();
    }
}

#[test]
fn original_core_reacquires_after_repeated_viewer_exit_without_recreating_the_pty() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let host_root = root.join("local-daemon-v1");
    let _cleanup = HostCleanup(host_root.clone());
    let owner = Core::open(root.join("shared-state-v1")).unwrap();
    call(&owner, "host.configure", json!({"helper":helper()}));
    let (send, receive) = mpsc::channel();
    owner
        .set_terminal_sink(Arc::new(move |_, generation, frame| {
            send.send((generation.to_owned(), frame))
                .map_err(|error| error.to_string())
        }))
        .unwrap();
    let open = |attachment: &str| {
        json!({"id":"reacquire-control","attachment":attachment,"directory":root,
            "shell":"default","rows":24,"cols":80})
    };
    let generation = call(&owner, "terminal.open", open("reacquire-owner"))["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    let observed = std::sync::Mutex::new(std::collections::HashMap::new());
    let same_cursor_updates = std::sync::atomic::AtomicUsize::new(0);
    let role = |core: &Core,
                receiver: &mpsc::Receiver<(String, utermd_local::daemon::Frame)>,
                attachment: &str,
                owned: bool| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let (actual_generation, frame) = receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|error| {
                    panic!("Expected owned={owned} on {attachment}: {error:?}")
                });
            eprintln!(
                "Control frame {attachment}: sequence={}, status={:?}, desired={owned}",
                frame.sequence, frame.input_control
            );
            assert_eq!(actual_generation, generation);
            assert!(frame.error.is_none(), "{:?}", frame.error);
            let previous = observed.lock().unwrap().insert(
                attachment.to_owned(),
                (frame.sequence, frame.input_control.clone()),
            );
            if previous.is_some_and(|(sequence, control)| {
                sequence == frame.sequence && control != frame.input_control
            }) {
                assert!(frame.data.is_empty() && !frame.reset);
                same_cursor_updates.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            call(
                core,
                "terminal.action",
                json!({"attachment":attachment,"action":"ack","sequence":frame.sequence.to_string()}),
            );
            if frame
                .input_control
                .as_ref()
                .is_some_and(|value| value.owned == owned)
            {
                return frame;
            }
        }
    };
    let initial = role(&owner, &receive, "reacquire-owner", true);
    let observer = Client::connect(&host_root).unwrap();
    let pid = status(&observer).pid;
    let mut sequences = vec![initial.sequence.to_string()];
    for round in 0..4 {
        eprintln!("Starting viewer exit round {round}");
        let viewer = Core::open(root.join("shared-state-v1")).unwrap();
        call(&viewer, "host.configure", json!({"helper":helper()}));
        let (viewer_send, viewer_receive) = mpsc::channel();
        viewer
            .set_terminal_sink(Arc::new(move |_, generation, frame| {
                viewer_send
                    .send((generation.to_owned(), frame))
                    .map_err(|error| error.to_string())
            }))
            .unwrap();
        let attachment = format!("reacquire-viewer-{round}");
        assert_eq!(
            call(&viewer, "terminal.open", open(&attachment))["generation"],
            generation
        );
        role(&viewer, &viewer_receive, &attachment, false);
        call(
            &viewer,
            "terminal.action",
            json!({"attachment":attachment,"action":"takeControl","rows":24,"cols":80}),
        );
        role(&viewer, &viewer_receive, &attachment, true);
        let revoked = role(&owner, &receive, "reacquire-owner", false);
        assert!(owner
            .terminal_write("reacquire-owner", b"echo DENIED\n")
            .unwrap_err()
            .message
            .contains("SESSION_CONTROL_REQUIRED"));
        viewer.close();
        let retained = status(&observer);
        assert_eq!(retained.pid, pid);
        assert!(retained
            .sessions
            .iter()
            .any(|value| value.spec.id == "reacquire-control"
                && value.generation == generation
                && value.running));
        call(
            &owner,
            "terminal.action",
            json!({"attachment":"reacquire-owner","action":"takeControl","rows":24,"cols":80}),
        );
        let recovered = role(&owner, &receive, "reacquire-owner", true);
        assert!(recovered.sequence >= revoked.sequence);
        assert_eq!((recovered.rows, recovered.cols), (24, 80));
        sequences.extend([revoked.sequence.to_string(), recovered.sequence.to_string()]);
        let marker = format!("REACQUIRED_{round}");
        let path = root.join(format!("round-{round}.txt"));
        let command = if cfg!(windows) {
            format!("'{marker}' | Set-Content -Encoding UTF8 'round-{round}.txt'\r")
        } else {
            format!("echo {marker} > round-{round}.txt\n")
        };
        owner
            .terminal_write("reacquire-owner", command.as_bytes())
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !std::fs::read(&path)
            .unwrap_or_default()
            .windows(marker.len())
            .any(|part| part == marker.as_bytes())
        {
            assert!(
                Instant::now() < deadline,
                "The retained PTY did not execute {marker}"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    call(
        &owner,
        "terminal.action",
        json!({"attachment":"reacquire-owner","action":"close"}),
    );
    assert!(!status(&observer)
        .sessions
        .iter()
        .any(|value| value.spec.id == "reacquire-control"));
    owner.close();
    if let Some(path) = std::env::var_os("UTERM_INPUT_REACQUIRE_REPORT") {
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
        std::fs::write(path, serde_json::to_vec_pretty(&json!({
            "passed":true,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
            "sourceHeadSHA":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_|tested.clone()),
            "testedMergeSHA":tested,"sourceTreeDirty":!git(&["status","--porcelain","--untracked-files=no"]).is_empty(),
            "actualPTY":true,"repeatedPeerExits":4,"sameHostPID":true,"sameGeneration":true,
            "ownerStreamRetained":true,"explicitTakeoverAfterEachExit":true,"oldInputRejected":true,
            "realPTYWriteAfterEachPeerExit":true,"sameSizeAfterEachTakeover":true,
            "controlChangesWithoutNewOutput":same_cursor_updates.load(std::sync::atomic::Ordering::Relaxed),
            "frameSequences":sequences,"exactClose":true,"guiAcceptance":false
        })).unwrap()).unwrap();
    }
}

#[test]
fn java_jar_uses_shared_host_literal_arguments_replay_and_generation_safe_stop() {
    let temporary = tempfile::tempdir().unwrap();
    let project = temporary.path().join("Java 项目");
    std::fs::create_dir(&project).unwrap();
    let root = project.canonicalize().unwrap();
    let core = Core::open(root.join("shared-state-v1")).unwrap();
    let host_root = root.join("local-daemon-v1");
    let _cleanup = HostCleanup(host_root.clone());
    call(&core, "host.configure", json!({"helper":helper()}));
    let java_home = PathBuf::from(
        std::env::var_os("JAVA_HOME")
            .expect("JAVA_HOME must point to a supported JDK 8, 11, 17 or 21"),
    );
    let tool = |name: &str| {
        java_home.join("bin").join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        })
    };
    let run = |name: &str, args: &[&str]| {
        let output = std::process::Command::new(tool(name))
            .args(args)
            .current_dir(uterm_core::java::path_text(&root))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{name}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    };
    std::fs::create_dir_all(root.join("target")).unwrap();
    std::fs::write(root.join("TaskProbe.java"), r#"
public class TaskProbe {
    public static void main(String[] args) throws Exception {
        System.out.println("READY:" + args[0] + ":" + System.getenv("VALUE") + ":" + System.getProperty("qa.value") + ":empty=" + args[1].isEmpty());
        System.out.flush();
        if (args.length > 2) Thread.sleep(60000);
        System.out.println("LAST:中文 e\u0301");
        System.err.println("ERR_LAST:中文");
        System.exit(7);
    }
}
"#).unwrap();
    run(
        "javac",
        &["-encoding", "UTF-8", "-d", "target", "TaskProbe.java"],
    );
    std::fs::write(root.join("TaskAgent.java"), "public class TaskAgent { public static void premain(String ignored, java.lang.instrument.Instrumentation instrumentation) { System.out.println(\"PREMAIN:\"+System.getProperty(\"qa.value\")); } }").unwrap();
    std::fs::write(root.join("agent.mf"), "Premain-Class: TaskAgent\n\n").unwrap();
    run(
        "javac",
        &["-encoding", "UTF-8", "-d", "target", "TaskAgent.java"],
    );
    run(
        "jar",
        &[
            "cfm",
            "target/qa-agent.jar",
            "agent.mf",
            "-C",
            "target",
            "TaskAgent.class",
        ],
    );
    let user_agent = temporary.path().join("user-agent.jar");
    std::fs::copy(root.join("target/qa-agent.jar"), &user_agent).unwrap();
    run(
        "jar",
        &[
            "cfe",
            "target/fixture.jar",
            "TaskProbe",
            "-C",
            "target",
            "TaskProbe.class",
        ],
    );
    std::fs::rename(
        root.join("target/fixture.jar"),
        root.join("target/literal 中文 & %.jar"),
    )
    .unwrap();
    std::fs::write(root.join("pom.xml"), "<project><modelVersion>4.0.0</modelVersion><groupId>qa</groupId><artifactId>literal</artifactId><version>1</version></project>").unwrap();
    std::fs::create_dir_all(root.join(".mvn/wrapper")).unwrap();
    std::fs::write(
        root.join(".mvn/wrapper/maven-wrapper.properties"),
        "distributionUrl=invalid:must-not-download\n",
    )
    .unwrap();
    let mut config =
        call(&core, "java.configuration", json!({"directory":root}))["project"].clone();
    config["java_home"] = json!(java_home);
    config["java_version"] = json!(uterm_core::java::probe(&java_home).unwrap().version);
    config["mode"] = json!("jar");
    config["jar"] = json!("target/literal 中文 & %.jar");
    config["offline"] = json!(true);
    let literal = "中文😀 & %PATH% * \" \\";
    config["arguments"] = json!([literal, ""]);
    config["vm_arguments"] = json!([
        format!("-javaagent:{}", uterm_core::java::path_text(&user_agent)),
        "-Dqa.value=属性😀 & %PATH%"
    ]);
    let start = |config: &Value| {
        call(
            &core,
            "java.start",
            json!({"directory":root,"action":"run","config":config,"environment":{"VALUE":"环境 & %PATH%"}}),
        )
    };
    let task = start(&config);
    let client = Client::connect(&host_root).unwrap();
    let (send, receive) = mpsc::channel();
    core.set_terminal_sink(Arc::new(move |_, generation, frame| {
        send.send((generation.to_owned(), frame))
            .map_err(|e| e.to_string())
    }))
    .unwrap();
    let attach = |attachment: &str| json!({"id":task["spec"]["id"],"attachment":attachment,"directory":root,"shell":"default","rows":30,"cols":100,"taskOnly":true});
    call(&core, "terminal.open", attach("java-first"));
    let (first_generation, first) = receive.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(first_generation, task["generation"].as_str().unwrap());
    call(
        &core,
        "terminal.action",
        json!({"attachment":"java-first","action":"detach"}),
    );
    assert!(
        matches!(client.request(Operation::TaskSnapshot).unwrap(), Reply::Tasks(tasks) if tasks.iter().any(|entry| entry.spec.id == task["spec"]["id"].as_str().unwrap() && entry.generation == task["generation"].as_str().unwrap()))
    );
    for _ in receive.try_iter() {}
    call(&core, "terminal.open", attach("java-replay"));
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut bytes = Vec::new();
    let mut sequences = Vec::new();
    loop {
        let (generation, frame) = receive
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|error| {
                panic!(
                    "Java final frame: {error}; host {:?}",
                    client.request(Operation::TaskSnapshot)
                )
            });
        assert_eq!(generation, task["generation"].as_str().unwrap());
        if let Some(previous) = sequences.last() {
            assert!(frame.sequence >= *previous);
        }
        sequences.push(frame.sequence);
        bytes.extend_from_slice(&frame.data);
        call(
            &core,
            "terminal.action",
            json!({"attachment":"java-replay","action":"ack","sequence":frame.sequence.to_string()}),
        );
        if frame.exited {
            assert_eq!(
                frame.code,
                Some(7),
                "Java task final output: {}",
                String::from_utf8_lossy(&bytes)
            );
            break;
        }
    }
    if cfg!(windows) {
        assert!(
            !std::fs::read_dir(&host_root).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("java-utf8-jdk8-")),
            "A normally completed Java task must release its launcher cache"
        );
    }
    let text = String::from_utf8(bytes).unwrap();
    assert!(
        text.contains(&format!(
            "READY:{literal}:环境 & %PATH%:属性😀 & %PATH%:empty=true"
        )),
        "{text}"
    );
    assert!(text.contains("PREMAIN:属性😀 & %PATH%"), "{text}");
    assert!(
        text.contains("LAST:中文 e\u{301}") && text.contains("ERR_LAST:中文"),
        "{text}"
    );
    assert!(first.sequence <= *sequences.last().unwrap());
    config["arguments"] = json!([literal, "", "wait"]);
    let live = start(&config);
    let request = |method: &str, generation: &str| {
        core.execute(&serde_json::to_vec(&json!({"version":1,"id":"java-stop","method":method,"params":{"id":live["spec"]["id"],"generation":generation,"force":true}})).unwrap())
    };
    assert_eq!(
        request("java.stop", "stale-generation").error.unwrap().code,
        "JAVA_TASK_REPLACED"
    );
    assert_eq!(
        request("python.stop", live["generation"].as_str().unwrap())
            .error
            .unwrap()
            .code,
        "PYTHON_TASK_INVALID"
    );
    assert!(
        matches!(client.request(Operation::TaskSnapshot).unwrap(), Reply::Tasks(tasks) if tasks.iter().any(|entry| entry.spec.id == live["spec"]["id"].as_str().unwrap() && entry.running))
    );
    assert!(request("java.stop", live["generation"].as_str().unwrap())
        .error
        .is_none());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let Reply::Tasks(tasks) = client.request(Operation::TaskSnapshot).unwrap() else {
            panic!("Expected tasks")
        };
        if tasks.iter().all(|task| !task.running) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Java force stop left a running task"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    let python = std::process::Command::new(if cfg!(windows) { "python" } else { "python3" })
        .args(["-I", "-c", "import sys; print(sys.executable)"])
        .output()
        .unwrap();
    assert!(python.status.success());
    std::fs::write(root.join("foreign.py"), "import time\ntime.sleep(60)\n").unwrap();
    let mut foreign_config =
        call(&core, "python.configuration", json!({"directory":root}))["project"].clone();
    foreign_config["interpreter"] = json!(String::from_utf8(python.stdout).unwrap().trim());
    foreign_config["target"] = json!("foreign.py");
    let foreign = call(
        &core,
        "python.start",
        json!({"directory":root,"config":foreign_config,"environment":{}}),
    );
    let rejected = core.execute(&serde_json::to_vec(&json!({"version":1,"id":"foreign-java-stop","method":"java.stop","params":{"id":foreign["spec"]["id"],"generation":foreign["generation"],"force":true}})).unwrap());
    assert_eq!(rejected.error.unwrap().code, "JAVA_TASK_FAMILY");
    assert!(
        matches!(client.request(Operation::TaskSnapshot).unwrap(), Reply::Tasks(tasks) if tasks.iter().any(|entry| entry.spec.id == foreign["spec"]["id"].as_str().unwrap() && entry.running))
    );
    call(
        &core,
        "python.stop",
        json!({"id":foreign["spec"]["id"],"generation":foreign["generation"],"force":true}),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let Reply::Tasks(tasks) = client.request(Operation::TaskSnapshot).unwrap() else {
            panic!("Expected tasks")
        };
        if tasks.iter().all(|task| !task.running) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Foreign task cleanup did not finish"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    core.close();
    client.request(Operation::ShutdownIfIdle).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while host_root.join("endpoint.json").exists() {
        assert!(Instant::now() < deadline, "Java host did not clean up");
        std::thread::sleep(Duration::from_millis(25));
    }
    if let Some(path) = std::env::var_os("UTERM_JAVA_CORE_REPORT") {
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
        let java_version = run("java", &["-version"]);
        std::fs::write(path, serde_json::to_vec_pretty(&json!({
            "passed":true,"sourceHeadSHA":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_|tested.clone()),"testedMergeSHA":tested,
            "sourceTreeDirty":!git(&["status","--porcelain","--untracked-files=no"]).is_empty(),
            "platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"java":String::from_utf8_lossy(&java_version.stderr),
            "exitCode":7,"output":text,"generation":task["generation"],"sequences":sequences.iter().map(u64::to_string).collect::<Vec<_>>(),
            "normalLauncherCacheReleased":true,"literalArgumentsEnvironmentAndVmProperty":true,"unicodeQuotesWildcardAndTrailingSlashPreserved":true,"emptyArgumentPreserved":true,"invalidWrapperBypassedForExistingJar":true,"unicodeWorkingDirectory":true,"userAgentSawExactPropertyBeforeMain":true,
            "detachReattachSameGeneration":true,"staleStopRefused":true,"pythonStopRefused":true,"javaStopRefusedPythonTask":true,"forceStopCleanedTask":true,"hostCleanedUp":true
        })).unwrap()).unwrap();
    }
}

#[test]
fn python_task_replays_exact_pipe_bytes_and_survives_client_detach() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let core = Core::open(root.join("shared-state-v1")).unwrap();
    let host_root = root.join("local-daemon-v1");
    let _cleanup = HostCleanup(host_root.clone());
    call(&core, "host.configure", json!({"helper":helper()}));
    let output = std::process::Command::new(if cfg!(windows) { "python" } else { "python3" })
        .args(["-I", "-c", "import sys; print(sys.executable)"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let interpreter = String::from_utf8(output.stdout).unwrap().trim().to_owned();
    std::fs::write(root.join("task 中文 & %.py"),
        "import sys,os,time\nprint('READY:'+sys.argv[1]+':'+os.environ['VALUE'],flush=True)\ntime.sleep(0.2)\nprint('LAST:中文 e\\u0301',flush=True)\nsys.exit(7)\n").unwrap();
    let mut config =
        call(&core, "python.configuration", json!({"directory":root}))["project"].clone();
    config["interpreter"] = json!(interpreter);
    config["target"] = json!("task 中文 & %.py");
    config["arguments"] = json!(["literal & %PATH%"]);
    let task = call(
        &core,
        "python.start",
        json!({"directory":root,"config":config,"environment":{"VALUE":"环境 & %PATH%"}}),
    );
    let (send, receive) = mpsc::channel();
    core.set_terminal_sink(Arc::new(move |_, _, frame| {
        send.send(frame).map_err(|e| e.to_string())
    }))
    .unwrap();
    let attach = |attachment: &str| json!({"id":task["spec"]["id"],"attachment":attachment,"directory":root,"shell":"default","rows":30,"cols":100,"taskOnly":true});
    call(&core, "terminal.open", attach("python-first"));
    let first = receive.recv_timeout(Duration::from_secs(10)).unwrap();
    call(
        &core,
        "terminal.action",
        json!({"attachment":"python-first","action":"detach"}),
    );
    let client = Client::connect(&host_root).unwrap();
    assert!(
        matches!(client.request(Operation::TaskSnapshot).unwrap(), Reply::Tasks(tasks) if tasks.iter().any(|value| value.spec.id == task["spec"]["id"].as_str().unwrap()))
    );
    call(&core, "terminal.open", attach("python-replay"));
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut bytes = Vec::new();
    let mut sequence = None;
    loop {
        assert!(
            Instant::now() < deadline,
            "Python task did not publish its final frame"
        );
        let frame = receive
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|error| {
                panic!(
                    "Python replay did not finish within the shared deadline: {error}; last sequence {sequence:?}; host {:?}",
                    client.request(Operation::TaskSnapshot)
                )
            });
        if let Some(previous) = sequence {
            assert!(frame.sequence >= previous);
        }
        sequence = Some(frame.sequence);
        bytes.extend_from_slice(&frame.data);
        call(
            &core,
            "terminal.action",
            json!({"attachment":"python-replay","action":"ack","sequence":frame.sequence.to_string()}),
        );
        if frame.exited {
            assert_eq!(frame.code, Some(7));
            break;
        }
    }
    let text = String::from_utf8(bytes).unwrap();
    assert!(
        text.contains("READY:literal & %PATH%:环境 & %PATH%"),
        "{text}"
    );
    assert!(text.contains("LAST:中文 e\u{301}"), "{text}");
    assert!(first.sequence <= sequence.unwrap());
    std::fs::write(root.join("foreign.py"), "import time\ntime.sleep(30)\n").unwrap();
    let foreign_config = uterm_core::python::RunConfig {
        interpreter: config["interpreter"].as_str().unwrap().into(),
        target: "foreign.py".into(),
        ..Default::default()
    };
    let Reply::Opened { generation } = client
        .request(Operation::OpenTask {
            spec: utermd_local::daemon::SessionSpec {
                id: "foreign-task".into(),
                directory: root.clone(),
                shell: "default".into(),
                agent: None,
                ssh: None,
            },
            task: utermd_local::tasks::TaskInfo {
                root: root.clone(),
                name: "Other task".into(),
                action: "java:run".into(),
                created: 1,
            },
            launch: uterm_core::python::build_launch(&root, &foreign_config, Default::default())
                .unwrap(),
            rows: 30,
            cols: 100,
        })
        .unwrap()
    else {
        panic!("Foreign task did not open");
    };
    let denied = core.execute(&serde_json::to_vec(&json!({"version":1,"id":"foreign-stop","method":"python.stop","params":{"id":"foreign-task","generation":generation,"force":true}})).unwrap());
    assert_eq!(denied.error.unwrap().code, "PYTHON_TASK_INVALID");
    assert!(
        matches!(client.request(Operation::TaskSnapshot).unwrap(), Reply::Tasks(tasks) if tasks.iter().any(|task| task.spec.id == "foreign-task" && task.running))
    );
    client
        .request(Operation::StopTask {
            id: "foreign-task".into(),
            generation,
            force: true,
        })
        .unwrap();
    core.close();
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

#[cfg(unix)]
#[test]
fn slow_consumer_preserves_order_and_resets_expired_history_without_stalling_the_pty() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().canonicalize().unwrap();
    let host_root = directory.join("local-daemon-v1");
    let _cleanup = HostCleanup(host_root.clone());
    let core = Core::open(directory.join("shared-state-v1")).unwrap();
    call(&core, "host.configure", json!({"helper":helper()}));
    let (sender, receiver) = mpsc::channel();
    core.set_terminal_sink(Arc::new(move |_, _, frame| {
        sender.send(frame).map_err(|e| e.to_string())
    }))
    .unwrap();
    let id = "slow-consumer";
    let params = json!({"id":id,"attachment":"before","directory":directory,"shell":"default","rows":24,"cols":200});
    let generation = call(&core, "terminal.open", params.clone())["generation"]
        .as_str()
        .unwrap()
        .to_string();
    let first = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    let payload = "x".repeat(120);
    let command = format!("i=0; while test \"$i\" -lt 1000; do printf 'LOAD_%04d_{payload} 中文 é\\n' \"$i\"; i=$((i+1)); done; printf 'LOAD_%s\\n' END; : > load-ready\r");
    core.terminal_write("before", command.as_bytes()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !directory.join("load-ready").exists() {
        assert!(
            Instant::now() < deadline,
            "A paused consumer stalled the producer"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(receiver.recv_timeout(Duration::from_millis(75)).is_err());
    call(
        &core,
        "terminal.action",
        json!({"attachment":"before","action":"ack","sequence":first.sequence + 1}),
    );
    assert!(
        receiver.recv_timeout(Duration::from_millis(75)).is_err(),
        "An incorrect ack released the pending frame"
    );
    call(
        &core,
        "terminal.action",
        json!({"attachment":"before","action":"ack","sequence":first.sequence}),
    );
    let mut bytes = Vec::new();
    let mut previous = first.sequence;
    let mut frames = 0;
    loop {
        let frame = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            frame.sequence > previous && !frame.reset,
            "Unexpired output must remain ordered deltas"
        );
        previous = frame.sequence;
        frames += 1;
        bytes.extend(frame.data);
        if bytes.windows(8).any(|part| part == b"LOAD_END") {
            break;
        }
        call(
            &core,
            "terminal.action",
            json!({"attachment":"before","action":"ack","sequence":previous}),
        );
    }
    let mut cursor = 0;
    for index in 0..1000 {
        let expected = format!("LOAD_{index:04}_{payload} 中文 é");
        let position = bytes[cursor..]
            .windows(expected.len())
            .position(|part| part == expected.as_bytes())
            .expect("An ordered record was lost");
        cursor += position + expected.len();
    }
    call(
        &core,
        "terminal.action",
        json!({"attachment":"before","action":"detach"}),
    );
    let mut reconnect = params;
    reconnect["attachment"] = json!("after");
    reconnect["reconnectOnly"] = json!(true);
    assert_eq!(
        call(&core, "terminal.open", reconnect)["generation"],
        generation
    );
    let replay = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(replay.reset && replay.data.windows(8).any(|part| part == b"LOAD_END"));
    let late = core.execute(br#"{"version":1,"id":"late","method":"terminal.action","params":{"attachment":"before","action":"ack","sequence":"0"}}"#);
    assert!(
        late.error.is_some(),
        "A detached attachment must not acknowledge the new connection"
    );
    core.terminal_write("after", "yes 'OVERFLOW output 中文' | head -n 90000; printf 'OVERFLOW_%s\\n' READY; : > overflow-ready\r".as_bytes()).unwrap();
    let observer = Client::connect(&host_root).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(Instant::now() < deadline, "The overflow producer stalled");
        let Reply::Frame(frame) = observer
            .request(Operation::Read {
                id: id.into(),
                generation: generation.clone(),
                after: Some(replay.sequence),
            })
            .unwrap()
        else {
            panic!("Expected a real overflow frame")
        };
        if directory.join("overflow-ready").exists()
            && frame.data.windows(14).any(|part| part == b"OVERFLOW_READY")
        {
            assert!(
                frame.reset,
                "Expired raw history requires an explicit screen reset"
            );
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(receiver.recv_timeout(Duration::from_millis(75)).is_err());
    call(
        &core,
        "terminal.action",
        json!({"attachment":"after","action":"ack","sequence":replay.sequence}),
    );
    let recovered = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(recovered.reset && recovered.sequence > replay.sequence);
    assert!(recovered.data.len() < 1024 * 1024);
    assert!(recovered
        .data
        .windows(14)
        .any(|part| part == b"OVERFLOW_READY"));
    let reset_size = recovered.data.len();
    core.close();
    assert!(status(&observer)
        .sessions
        .iter()
        .any(|s| s.running && s.generation == generation));
    if let Some(path) = std::env::var_os("UTERM_TERMINAL_LOAD_REPORT") {
        let git = |args: &[&str]| {
            let result = std::process::Command::new("git")
                .args(args)
                .current_dir(env!("CARGO_MANIFEST_DIR"))
                .output()
                .unwrap();
            assert!(result.status.success());
            String::from_utf8(result.stdout).unwrap().trim().to_string()
        };
        let tested_merge = git(&["rev-parse", "HEAD"]);
        let source_head = std::env::var("PR_HEAD_SHA").unwrap_or_else(|_| tested_merge.clone());
        std::fs::write(path, serde_json::to_vec_pretty(&json!({"passed":true,"platform":std::env::consts::OS,
            "sourceHeadSHA":source_head,"testedMergeSHA":tested_merge,
            "sourceTreeDirty":!git(&["status","--porcelain","--untracked-files=no"]).is_empty(),
            "architecture":std::env::consts::ARCH,"orderedRecords":1000,"rawDeltaBytes":bytes.len(),"deltaFrames":frames,
            "incorrectAckBlocked":true,"producerCompletedWithoutAck":true,"lateAttachmentRejected":true,
            "reconnectRetainedGeneration":true,"overflowRows":90000,"overflowResetBytes":reset_size,
            "overflowUsedExplicitReset":true,"closeWhileUnacknowledgedPreservedProcess":true})).unwrap()).unwrap();
    }
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
#[test]
#[ignore = "Build the immutable release helper with pnpm test:legacy-host"]
fn immutable_release_host_preserves_real_binary_replay_and_upgrades_only_after_close() {
    let old_helper = PathBuf::from(std::env::var_os("UTERM_RELEASE_HOST_BINARY").unwrap())
        .canonicalize()
        .unwrap();
    let new_helper = helper();
    assert_ne!(old_helper, new_helper);
    let old_bytes = std::fs::read(&old_helper).unwrap();
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().canonicalize().unwrap();
    let host_root = directory.join("local-daemon-v1");
    let _cleanup = HostCleanup(host_root.clone());
    let old = utermd_local::daemon::ensure_running(&host_root, &old_helper).unwrap();
    let capabilities = serde_json::to_value(old.request(Operation::Ping).unwrap()).unwrap();
    let generation = open_upgrade_session(&old, &directory);
    let before = status(&old);
    assert_eq!(before.executable.canonicalize().unwrap(), old_helper);

    let core = Core::open(directory.join("shared-state-v1")).unwrap();
    call(&core, "host.configure", json!({"helper":new_helper}));
    let (sender, receiver) = mpsc::channel();
    core.set_terminal_sink(Arc::new(move |_, generation, frame| {
        sender
            .send((generation.to_string(), frame))
            .map_err(|e| e.to_string())
    }))
    .unwrap();
    let attached = call(
        &core,
        "terminal.open",
        json!({
            "id":"helper-upgrade-session", "attachment":"release-reference", "directory":directory,
            "shell":if cfg!(windows){"cmd"}else{"default"},"rows":24,"cols":80
        }),
    );
    assert_eq!(attached["generation"], generation);
    assert_eq!(status(&old).pid, before.pid);
    if cfg!(windows) {
        assert!(old
            .require_java_utf8_support()
            .unwrap_err()
            .to_string()
            .contains("JAVA_UTF8_HOST_UPGRADE_REQUIRED"));
        assert_eq!(
            status(&old).pid,
            before.pid,
            "Unsupported new Java launch must not restart an active old host"
        );
    }
    let command = if cfg!(windows) {
        b"set UTERM_REFERENCE_SUFFIX=READY\recho UTERM_REFERENCE_%UTERM_REFERENCE_SUFFIX%\r"
            .as_slice()
    } else {
        b"printf 'UTERM_REFERENCE_%s\\n' READY\r".as_slice()
    };
    core.terminal_write("release-reference", command).unwrap();
    let mut output = Vec::new();
    let mut frames = 0;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !output
        .windows(b"UTERM_REFERENCE_READY".len())
        .any(|part| part == b"UTERM_REFERENCE_READY")
    {
        assert!(
            Instant::now() < deadline,
            "The release PTY did not execute the command"
        );
        let (received_generation, frame) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(received_generation, generation);
        assert!(!frame.exited);
        frames += 1;
        output.extend(frame.data);
        call(
            &core,
            "terminal.action",
            json!({"attachment":"release-reference","action":"ack","sequence":frame.sequence.to_string()}),
        );
    }
    core.close();
    let detached = status(&old);
    assert_eq!(detached.pid, before.pid);
    assert!(detached
        .sessions
        .iter()
        .any(|s| s.running && s.generation == generation));
    upgrade_session_alive(&old, &generation);
    old.request(Operation::Close {
        id: "helper-upgrade-session".into(),
        generation: generation.clone(),
    })
    .unwrap();
    let broker = uterm_core::host::HostBroker::new(host_root.clone(), new_helper);
    let upgraded = status(&broker.client().unwrap());
    assert_ne!(upgraded.pid, before.pid);
    assert!(upgraded
        .executable
        .canonicalize()
        .unwrap()
        .starts_with(host_root.join("executables")));
    assert!(!upgraded.sessions.iter().any(|s| s.running));
    assert_eq!(status(&broker.client().unwrap()).pid, upgraded.pid);
    assert!(std::fs::read(&old_helper).unwrap() == old_bytes);
    if let Some(path) = std::env::var_os("UTERM_COMPAT_REPORT_FILE") {
        std::fs::write(path, serde_json::to_vec_pretty(&json!({
            "passed":true,"oldPID":before.pid,"newPID":upgraded.pid,"generation":generation,
            "oldExecutable":old_helper,"newExecutable":upgraded.executable,"ping":capabilities,
            "binaryFramesAcknowledged":frames,"retainedWhileActive":true,"detachPreservedProcess":true,
            "literalInputExecuted":true,"upgradedOnlyAfterExplicitClose":true,"sourceBinaryUnchanged":true
        })).unwrap()).unwrap();
    }
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
