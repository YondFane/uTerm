use super::*;
use std::io::{Read, Write};

fn server(replies: Vec<Vec<u8>>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/file", listener.local_addr().unwrap());
    (
        url,
        std::thread::spawn(move || {
            let mut requests = Vec::new();
            for reply in replies {
                let start = std::time::Instant::now();
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(start.elapsed() < Duration::from_secs(10));
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    assert!(request.len() < 16384);
                }
                requests.push(String::from_utf8(request).unwrap().to_ascii_lowercase());
                let _ = stream.write_all(&reply);
            }
            requests
        }),
    )
}

fn reply(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut bytes = format!("HTTP/1.1 {status}\r\nConnection: close\r\n{headers}\r\n").into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

#[test]
fn transient_failures_resume_with_etag_and_complete_cache_needs_no_network() {
    let (url, worker) = server(vec![
        reply(
            "503 Service Unavailable",
            "Retry-After: 0\r\nContent-Length: 0\r\n",
            b"",
        ),
        reply("200 OK", "ETag: \"same\"\r\nContent-Length: 6\r\n", b"abc"),
        reply(
            "206 Partial Content",
            "ETag: \"same\"\r\nContent-Range: bytes 3-5/6\r\nContent-Length: 3\r\n",
            b"def",
        ),
    ]);
    let directory = tempfile::tempdir().unwrap();
    run(async {
        let path = fetch(
            directory.path(),
            "test",
            &url,
            &AtomicBool::new(false),
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"abcdef");
        assert_eq!(
            fetch(
                directory.path(),
                "test",
                "http://127.0.0.1:1",
                &AtomicBool::new(false),
                |_, _| {}
            )
            .await
            .unwrap(),
            path
        );
    });
    let requests = worker.join().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[2].contains("range: bytes=3-"));
    assert!(requests[2].contains("if-range: \"same\""));
}

#[test]
fn ignored_and_invalid_ranges_restart_without_appending_old_bytes() {
    for invalid in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(cache_path(directory.path(), "test"), b"old").unwrap();
        let mut replies = Vec::new();
        if invalid {
            replies.push(reply(
                "206 Partial Content",
                "Content-Range: bytes 0-2/6\r\nContent-Length: 3\r\n",
                b"bad",
            ));
        }
        replies.push(reply("200 OK", "Content-Length: 6\r\n", b"newone"));
        let (url, worker) = server(replies);
        let path = run(fetch(
            directory.path(),
            "test",
            &url,
            &AtomicBool::new(false),
            |_, _| {},
        ))
        .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"newone");
        let requests = worker.join().unwrap();
        assert!(requests[0].contains("range: bytes=3-"));
        if invalid {
            assert!(!requests[1].contains("range:"));
        }
    }
}

#[test]
fn permanent_http_errors_and_long_retry_after_are_not_retried() {
    for (status, headers, code) in [
        (
            "404 Not Found",
            "Content-Length: 0\r\n",
            "DOWNLOAD_NOT_FOUND",
        ),
        ("403 Forbidden", "Content-Length: 0\r\n", "DOWNLOAD_ACCESS"),
        (
            "429 Too Many Requests",
            "Content-Length: 0\r\nRetry-After: 60\r\n",
            "DOWNLOAD_RATE_LIMIT",
        ),
    ] {
        let (url, worker) = server(vec![reply(status, headers, b"")]);
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            run(fetch(
                directory.path(),
                "test",
                &url,
                &AtomicBool::new(false),
                |_, _| {}
            ))
            .unwrap_err()
            .to_string(),
            code
        );
        assert_eq!(worker.join().unwrap().len(), 1);
    }
}

#[test]
fn failures_are_bounded_and_partial_bytes_survive_a_new_attempt() {
    let (url, worker) = server(vec![
        reply(
            "503 Service Unavailable",
            "Content-Length: 0\r\n",
            b""
        );
        3
    ]);
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(cache_path(directory.path(), "test"), b"abc").unwrap();
    assert_eq!(
        run(fetch(
            directory.path(),
            "test",
            &url,
            &AtomicBool::new(false),
            |_, _| {}
        ))
        .unwrap_err()
        .to_string(),
        "DOWNLOAD_SERVER"
    );
    assert_eq!(worker.join().unwrap().len(), 3);
    let (url, worker) = server(vec![reply(
        "206 Partial Content",
        "Content-Range: bytes 3-5/6\r\nContent-Length: 3\r\n",
        b"def",
    )]);
    let path = run(fetch(
        directory.path(),
        "test",
        &url,
        &AtomicBool::new(false),
        |_, _| {},
    ))
    .unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"abcdef");
    worker.join().unwrap();
}

#[test]
fn cancellation_storage_failures_and_certificate_errors_are_not_network_retries() {
    let directory = tempfile::tempdir().unwrap();
    assert_eq!(
        run(fetch(
            directory.path(),
            "test",
            "http://127.0.0.1:1",
            &AtomicBool::new(true),
            |_, _| {}
        ))
        .unwrap_err()
        .to_string(),
        "DOWNLOAD_CANCELLED"
    );
    let file = directory.path().join("file");
    std::fs::write(&file, b"file").unwrap();
    assert_eq!(
        run(fetch(
            &file,
            "test",
            "http://127.0.0.1:1",
            &AtomicBool::new(false),
            |_, _| {}
        ))
        .unwrap_err()
        .to_string(),
        "DOWNLOAD_STORAGE"
    );
    assert!(!retryable(&classify_network(
        "invalid peer certificate",
        false
    )));
    assert!(!retryable(&anyhow::anyhow!("DOWNLOAD_VERIFY")));
}
