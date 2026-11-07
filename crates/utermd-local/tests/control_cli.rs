use std::process::Command;
use std::time::{Duration, Instant};

#[test]
fn standalone_cli_uses_the_shared_authenticated_server_and_drains_on_close() {
    let directory = tempfile::tempdir().unwrap();
    let service = utermd_local::control::Control::start(directory.path()).unwrap();
    assert_eq!(service.status()["enabled"], false);
    assert!(!directory.path().join("control-v1/endpoint.json").exists());
    assert!(utermd_local::control::Control::start(directory.path()).is_err());
    service.configure(true).unwrap();
    struct Process(Option<std::process::Child>);
    impl Drop for Process {
        fn drop(&mut self) {
            if let Some(child) = self.0.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    let mut client = Process(Some(
        Command::new(env!("CARGO_BIN_EXE_utermd-local"))
            .arg("--control")
            .arg("--data-dir")
            .arg(directory.path())
            .args([
                "sessions",
                "send",
                "session-id",
                "中文 $literal `text`",
                "--enter",
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap(),
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    let request = loop {
        if let Some(request) = service.poll().unwrap() {
            break request;
        }
        assert!(
            Instant::now() < deadline,
            "CLI request did not reach the shared queue"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(request.method, "sessions.send");
    assert_eq!(request.params["text"], "中文 $literal `text`\r");
    assert!(
        service.poll().unwrap().is_none(),
        "Claimed requests must not dispatch twice"
    );
    service
        .reply(
            &request.id,
            serde_json::json!({"result":{"id":"session-id"}}),
        )
        .unwrap();
    let output = client.0.take().unwrap().wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["id"],
        "session-id"
    );

    let root = directory.path().to_owned();
    let pending = std::thread::spawn(move || {
        utermd_local::control::cli(vec![
            "--data-dir".into(),
            root.to_string_lossy().into(),
            "status".into(),
        ])
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let request = loop {
        if let Some(request) = service.poll().unwrap() {
            break request;
        }
        assert!(Instant::now() < deadline, "Second request did not queue");
        std::thread::sleep(Duration::from_millis(10));
    };
    let start = Instant::now();
    drop(service);
    assert!(pending.join().unwrap().unwrap_err().contains("closed"));
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "Closing must drain clients without the request timeout"
    );
    assert!(!directory.path().join("control-v1/endpoint.json").exists());
    let reopened = utermd_local::control::Control::start(directory.path()).unwrap();
    assert_eq!(
        reopened.status()["enabled"],
        true,
        "The preference survives service lifetime"
    );
    reopened
        .reply(&request.id, serde_json::json!({"result":"late"}))
        .unwrap();
    assert!(reopened.poll().unwrap().is_none());
    reopened.configure(false).unwrap();
    assert!(!directory.path().join("control-v1/endpoint.json").exists());
}

#[test]
fn standalone_helper_exposes_the_existing_control_cli() {
    let output = Command::new(env!("CARGO_BIN_EXE_utermd-local"))
        .args(["--control", "--help"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(reply["usage"]
        .as_str()
        .unwrap()
        .contains("sessions send ID TEXT [--enter]"));
    assert_eq!(
        utermd_local::control::parse_arguments(&[
            "sessions".into(),
            "send".into(),
            "id".into(),
            "中文 $literal `text`".into(),
            "--enter".into()
        ])
        .unwrap()
        .1["text"],
        "中文 $literal `text`\r"
    );
    assert!(utermd_local::control::valid_link(
        "uterm://session/00000000-0000-0000-0000-000000000001"
    )
    .is_ok());
    assert!(utermd_local::control::valid_link(
        "uterm://session/00000000-0000-0000-0000-000000000001?unexpected=1"
    )
    .is_err());
}
