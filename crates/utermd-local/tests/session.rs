#![cfg(unix)]
use portable_pty::CommandBuilder;
use std::{sync::mpsc, time::Duration};
use utermd_local::{Event, Session};

#[test]
fn input_resize_output_and_exit() {
    let (sender, receiver) = mpsc::channel();
    let mut command = CommandBuilder::new("/bin/sh");
    command.args([
        "-c",
        "read value; stty size; printf 'received:%s:中文\\n' \"$value\"; exit 7",
    ]);
    let session = Session::spawn(command, &std::env::temp_dir(), 24, 80, move |event| {
        sender.send(event)?;
        Ok(())
    })
    .expect("spawn");
    session.resize(35, 101).expect("resize");
    session.write(b"hello world\n".to_vec()).expect("write");
    let mut output = Vec::new();
    loop {
        match receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("session event")
        {
            Event::Output { sequence, data } => {
                output.extend(data);
                session.acknowledge(sequence);
            }
            Event::Exit { code } => {
                assert_eq!(code, Some(7));
                break;
            }
            Event::Error { message } => panic!("{message}"),
        }
    }
    let output = String::from_utf8(output).expect("UTF-8");
    assert!(output.contains("35 101"), "{output}");
    assert!(output.contains("received:hello world:中文"), "{output}");
}

#[test]
fn close_releases_output_waiting_for_acknowledgement() {
    let (sender, receiver) = mpsc::channel();
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", "while :; do printf 'output'; done"]);
    let session = Session::spawn(command, &std::env::temp_dir(), 24, 80, move |event| {
        sender.send(event)?;
        Ok(())
    })
    .expect("spawn");
    assert!(matches!(
        receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("output"),
        Event::Output { .. }
    ));
    assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
    session.close().expect("close");
    match receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("exit after close")
    {
        Event::Exit { .. } => (),
        Event::Error { message } => panic!("{message}"),
        Event::Output { .. } => panic!("output was not bounded"),
    }
    assert!(session.has_exited());
}

#[test]
fn closing_one_session_does_not_stop_another() {
    let (first_sender, first_receiver) = mpsc::channel();
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", "read value; printf 'first:%s\\n' \"$value\""]);
    let first = Session::spawn(command, &std::env::temp_dir(), 24, 80, move |event| {
        first_sender.send(event)?;
        Ok(())
    })
    .expect("first session");
    let (second_sender, second_receiver) = mpsc::channel();
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", "read value; printf 'second:%s\\n' \"$value\""]);
    let second = Session::spawn(command, &std::env::temp_dir(), 24, 80, move |event| {
        second_sender.send(event)?;
        Ok(())
    })
    .expect("second session");
    first.close().expect("close first");
    assert!(matches!(
        first_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("first exit"),
        Event::Exit { .. }
    ));
    second
        .write(b"still running\n".to_vec())
        .expect("write to second");
    let mut output = Vec::new();
    loop {
        match second_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("second event")
        {
            Event::Output { sequence, data } => {
                output.extend(data);
                second.acknowledge(sequence);
            }
            Event::Exit { code } => {
                assert_eq!(code, Some(0));
                break;
            }
            Event::Error { message } => panic!("{message}"),
        }
    }
    assert!(String::from_utf8(output)
        .expect("UTF-8")
        .contains("second:still running"));
}
