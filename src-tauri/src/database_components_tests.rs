use super::*;

fn download_server(
    responses: Vec<Vec<u8>>,
    cancel: Option<(std::sync::Arc<AtomicBool>, PathBuf)>,
) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/runtime", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let worker = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (index, response) in responses.into_iter().enumerate() {
            let start = std::time::Instant::now();
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            start.elapsed() < Duration::from_secs(10),
                            "no download request"
                        );
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
            requests.push(String::from_utf8(request).unwrap().to_lowercase());
            if index == 0 {
                if let Some((flag, path)) = &cancel {
                    stream.write_all(&response[..response.len() / 2]).unwrap();
                    let start = std::time::Instant::now();
                    while fs::metadata(path)
                        .map(|metadata| metadata.len())
                        .unwrap_or(0)
                        == 0
                    {
                        assert!(start.elapsed() < Duration::from_secs(5));
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    flag.store(true, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(200));
                    let _ = stream.write_all(&response[response.len() / 2..]);
                    continue;
                }
            }
            let _ = stream.write_all(&response);
        }
        requests
    });
    (url, worker)
}
fn reply(status: &str, headers: &str, bytes: &[u8]) -> Vec<u8> {
    let mut response =
        format!("HTTP/1.1 {status}\r\nConnection: close\r\n{headers}\r\n").into_bytes();
    response.extend_from_slice(bytes);
    response
}
fn download_artifact(bytes: &[u8], url: String) -> Artifact {
    Artifact {
        version: "qa".into(),
        url,
        filename: "qa.jar".into(),
        size: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
    }
}
#[test]
fn interrupted_download_resumes_from_saved_bytes_and_verifies_complete_content() {
    let bytes: Vec<u8> = (0..200_000).map(|value| (value % 251) as u8).collect();
    let offset = 80_000;
    let (url, server) = download_server(
        vec![
            reply(
                "200 OK",
                &format!("Content-Length: {}\r\n", bytes.len()),
                &bytes[..offset],
            ),
            reply(
                "206 Partial Content",
                &format!(
                    "Content-Length: {}\r\nContent-Range: bytes {offset}-{}/{}\r\n",
                    bytes.len() - offset,
                    bytes.len() - 1,
                    bytes.len()
                ),
                &bytes[offset..],
            ),
        ],
        None,
    );
    let artifact = download_artifact(&bytes, url);
    let directory = tempfile::tempdir().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        assert!(download_file(
            directory.path(),
            &artifact,
            &AtomicBool::new(false),
            |_| Ok(())
        )
        .await
        .is_err());
        assert_eq!(
            fs::metadata(partial_path(directory.path(), &artifact))
                .unwrap()
                .len(),
            offset as u64
        );
        let mut complete =
            download_file(directory.path(), &artifact, &AtomicBool::new(false), |_| {
                Ok(())
            })
            .await
            .unwrap();
        assert!(valid_file(complete.as_file_mut(), &artifact).unwrap());
    });
    let requests = server.join().unwrap();
    assert!(!requests[0].contains("range:"));
    assert!(requests[1].contains("range: bytes=80000-"));
    assert!(requests[1].contains("accept-encoding: identity"));
    assert!(requests[1].contains("user-agent: uterm/"));
    assert!(!partial_path(directory.path(), &artifact).exists());
}
#[test]
fn cancellation_retains_partial_download_for_a_later_attempt() {
    let bytes = vec![42; 200_000];
    let flag = std::sync::Arc::new(AtomicBool::new(false));
    let directory = tempfile::tempdir().unwrap();
    let mut artifact = download_artifact(&bytes, String::new());
    let (url, server) = download_server(
        vec![reply("200 OK", "Content-Length: 200000\r\n", &bytes)],
        Some((flag.clone(), partial_path(directory.path(), &artifact))),
    );
    artifact.url = url;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let error = runtime
        .block_on(download_file(
            directory.path(),
            &artifact,
            &flag,
            |_| Ok(()),
        ))
        .unwrap_err();
    assert_eq!(error.to_string(), "DB_COMPONENT_CANCELLED");
    let saved = fs::metadata(partial_path(directory.path(), &artifact))
        .unwrap()
        .len();
    assert!(saved > 0 && saved < artifact.size);
    server.join().unwrap();
    let offset = saved as usize;
    let (url, server) = download_server(
        vec![reply(
            "206 Partial Content",
            &format!(
                "Content-Length: {}\r\nContent-Range: bytes {offset}-{}/{}\r\n",
                bytes.len() - offset,
                bytes.len() - 1,
                bytes.len()
            ),
            &bytes[offset..],
        )],
        None,
    );
    artifact.url = url;
    let mut file = runtime
        .block_on(download_file(
            directory.path(),
            &artifact,
            &AtomicBool::new(false),
            |_| Ok(()),
        ))
        .unwrap();
    assert!(valid_file(file.as_file_mut(), &artifact).unwrap());
    assert!(server.join().unwrap()[0].contains(&format!("range: bytes={saved}-")));
}
#[test]
fn ignored_or_rejected_ranges_restart_without_appending_and_bad_headers_never_install() {
    let bytes = b"the complete pinned component";
    for rejected in [
        None,
        Some(("416 Range Not Satisfiable", "bytes */29")),
        Some(("206 Partial Content", "bytes 1-2/999")),
        Some(("206 Partial Content", "bytes 5-18446744073709551615/29")),
    ] {
        let mut responses = Vec::new();
        if let Some((status, range)) = rejected {
            responses.push(reply(
                status,
                &format!("Content-Length: 0\r\nContent-Range: {range}\r\n"),
                b"",
            ));
        }
        responses.push(reply(
            "200 OK",
            &format!("Content-Length: {}\r\n", bytes.len()),
            bytes,
        ));
        let (url, server) = download_server(responses, None);
        let artifact = download_artifact(bytes, url);
        let directory = tempfile::tempdir().unwrap();
        let path = partial_path(directory.path(), &artifact);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &bytes[..5]).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut file = runtime
            .block_on(download_file(
                directory.path(),
                &artifact,
                &AtomicBool::new(false),
                |_| Ok(()),
            ))
            .unwrap();
        assert!(valid_file(file.as_file_mut(), &artifact).unwrap());
        let requests = server.join().unwrap();
        assert!(requests[0].contains("range: bytes=5-"));
        if rejected.is_some() {
            assert!(!requests[1].contains("range:"));
        }
    }
}
#[test]
fn complete_cached_download_is_verified_without_a_request_and_tampered_bytes_are_removed() {
    let bytes = b"cached complete component";
    let artifact = download_artifact(bytes, "http://127.0.0.1:1/unused".into());
    let directory = tempfile::tempdir().unwrap();
    let path = partial_path(directory.path(), &artifact);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for modified in [false, true] {
        fs::write(
            &path,
            if modified {
                vec![0; bytes.len()]
            } else {
                bytes.to_vec()
            },
        )
        .unwrap();
        let mut file = runtime
            .block_on(download_file(
                directory.path(),
                &artifact,
                &AtomicBool::new(false),
                |_| Ok(()),
            ))
            .unwrap();
        assert_eq!(
            valid_file(file.as_file_mut(), &artifact).unwrap(),
            !modified
        );
        drop(file);
        assert!(!path.exists());
    }
}
#[cfg(unix)]
#[test]
fn local_java_detection_respects_selection_rejects_old_or_broken_java_and_falls_back() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let executable = |name: &str, version: &str, exit: u8| {
        let path = directory.path().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            format!("#!/bin/sh\nprintf '%s\\n' 'openjdk version \"{version}\"' >&2\nexit {exit}\n"),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    };
    let old = executable("old/bin/java", "1.8.0", 0);
    let broken = executable("broken/bin/java", "21.0.1", 1);
    let system = executable("system Java/bin/java", "17.0.1", 0);
    let managed = executable("runtime/jre/bin/java", "21.0.1", 0);
    let selected = executable("selected/bin/java", "25.0.1", 0);
    let candidates = || vec![old.clone(), broken.clone(), system.clone()];
    assert_eq!(
        select_java(directory.path(), candidates),
        Some((system.clone(), true))
    );
    fs::write(
        directory.path().join("java-path.txt"),
        selected.to_string_lossy().as_bytes(),
    )
    .unwrap();
    assert_eq!(
        select_java(directory.path(), candidates),
        Some((selected.clone(), true))
    );
    fs::remove_file(selected).unwrap();
    assert_eq!(
        select_java(directory.path(), candidates),
        Some((system, true))
    );
    assert_eq!(
        select_java(directory.path(), || vec![old, broken]),
        Some((managed.clone(), false))
    );
    fs::remove_file(managed).unwrap();
    assert!(select_java(directory.path(), Vec::new).is_none());
}
