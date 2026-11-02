use std::process::Command;

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
