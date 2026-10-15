use std::{
    io::{Read, Write},
    net::TcpStream,
    process::Command,
};
use utermd_local::ssh_askpass::{Endpoint, Server};

fn helper(endpoint: &Endpoint, prompt: &str) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_utermd-local"))
        .envs(endpoint.environment().unwrap())
        .arg(prompt)
        .output()
        .unwrap()
}

#[test]
fn askpass_authenticates_the_helper_and_only_answers_the_destination_once() {
    let server = Server::new(
        "fixture-secret".into(),
        "qa@127.0.0.1's password:".into(),
        |_| false,
    )
    .unwrap();
    let mut wrong = server.endpoint.clone();
    wrong.token = uuid::Uuid::new_v4().to_string();
    assert!(!helper(&wrong, "qa@127.0.0.1's password:").status.success());
    assert!(!helper(&server.endpoint, "jump@other's password:")
        .status
        .success());
    assert!(!helper(&server.endpoint, "Verification code:")
        .status
        .success());
    let answer = helper(&server.endpoint, "qa@127.0.0.1's password: ");
    assert!(answer.status.success());
    assert_eq!(answer.stdout, b"fixture-secret\n");
    assert!(!helper(&server.endpoint, "qa@127.0.0.1's password:")
        .status
        .success());
    assert!(server.finished());
}

#[test]
fn askpass_bounds_messages_and_keeps_fingerprint_confirmation_separate() {
    for invalid in [String::new(), "x".repeat(1024), "line\nbreak".into()] {
        assert!(Server::new(invalid, "qa@host\'s password:".into(), |_| false).is_err());
    }
    let server = Server::new(
        "fixture-secret".into(),
        "qa@host's password:".into(),
        |prompt| prompt.contains("SHA256:fixture"),
    )
    .unwrap();
    let mut socket = TcpStream::connect(("127.0.0.1", server.endpoint.port)).unwrap();
    socket.write_all(&(20_000u32).to_be_bytes()).unwrap();
    // Rejected frames can close with EOF or a TCP reset on different systems. 不同系统拒绝帧时可能返回 EOF 或 TCP 重置。
    match socket.read(&mut [0; 1]) {
        Ok(count) => assert_eq!(count, 0),
        Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset),
    }
    let prompt = "The authenticity of host cannot be established.\nED25519 key fingerprint is SHA256:fixture.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?";
    assert_eq!(helper(&server.endpoint, prompt).stdout, b"yes\n");
    assert!(!server.finished());
    assert_eq!(
        helper(&server.endpoint, "qa@host's password:").stdout,
        b"fixture-secret\n"
    );
    let cancelled = Server::new(
        "fixture-secret".into(),
        "qa@host's password:".into(),
        |_| false,
    )
    .unwrap();
    assert_eq!(helper(&cancelled.endpoint, prompt).stdout, b"no\n");
    let endpoint = cancelled.endpoint.clone();
    drop(cancelled);
    assert!(!helper(&endpoint, "qa@host's password:").status.success());
}
