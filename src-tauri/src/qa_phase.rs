use std::io;
use std::time::Duration;

pub(crate) fn replace_phase(mut replace: impl FnMut() -> io::Result<()>) -> io::Result<usize> {
    for attempt in 1..=10 {
        match replace() {
            Ok(()) => return Ok(attempt),
            Err(error)
                if cfg!(windows)
                    && matches!(error.raw_os_error(), Some(5 | 32 | 33))
                    && attempt < 10 =>
            {
                // Only the isolated QA heartbeat retries a Windows replacement denied by an open handle.
                // 仅隔离 QA 心跳在 Windows 文件句柄阻止替换时重试，不重放应用变更。
                eprintln!("QA heartbeat replacement deferred at attempt {attempt}: {error}");
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "uterm-qa-phase-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn replaces_the_phase_atomically_and_does_not_replay_success() {
        let directory = Directory::new();
        let source = directory.0.join("staged");
        let destination = directory.0.join("phase.json");
        fs::write(&source, "NEW 中文").unwrap();
        fs::write(&destination, "OLD").unwrap();
        let attempts = replace_phase(|| fs::rename(&source, &destination)).unwrap();
        assert_eq!(attempts, 1);
        assert_eq!(fs::read_to_string(destination).unwrap(), "NEW 中文");
        assert!(!source.exists());
    }

    #[test]
    fn unrelated_errors_return_immediately_and_leave_original_bytes() {
        let directory = Directory::new();
        let destination = directory.0.join("phase.json");
        fs::write(&destination, "ORIGINAL").unwrap();
        let mut calls = 0;
        let error = replace_phase(|| {
            calls += 1;
            Err(io::Error::new(io::ErrorKind::InvalidData, "invalid phase"))
        })
        .unwrap_err();
        assert_eq!(calls, 1);
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read_to_string(destination).unwrap(), "ORIGINAL");
    }

    #[cfg(windows)]
    fn hold_without_delete_sharing(path: &std::path::Path) -> fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2)
            .open(path)
            .unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn windows_open_reader_recovers_only_after_the_real_lock_is_released() {
        let directory = Directory::new();
        let source = directory.0.join("staged");
        let destination = directory.0.join("phase.json");
        fs::write(&source, "NEW 中文").unwrap();
        fs::write(&destination, "ORIGINAL").unwrap();
        let reader = hold_without_delete_sharing(&destination);
        let (observed, receive) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut first = true;
            let result = replace_phase(|| {
                let result = fs::rename(&source, &destination);
                if first {
                    assert!(
                        result.is_err(),
                        "The actual open reader must block replacement"
                    );
                    observed.send(()).unwrap();
                    resume.recv_timeout(Duration::from_secs(10)).unwrap();
                    first = false;
                }
                result
            });
            (result, source, destination)
        });
        receive.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(
            fs::read_to_string(&directory.0.join("phase.json")).unwrap(),
            "ORIGINAL"
        );
        drop(reader);
        release.send(()).unwrap();
        let (result, source, destination) = worker.join().unwrap();
        assert!((2..=10).contains(&result.unwrap()));
        assert_eq!(fs::read_to_string(destination).unwrap(), "NEW 中文");
        assert!(!source.exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_persistent_lock_is_bounded_and_preserves_both_files() {
        let directory = Directory::new();
        let source = directory.0.join("staged");
        let destination = directory.0.join("phase.json");
        fs::write(&source, "NEW").unwrap();
        fs::write(&destination, "ORIGINAL").unwrap();
        let reader = hold_without_delete_sharing(&destination);
        let mut calls = 0;
        let error = replace_phase(|| {
            calls += 1;
            fs::rename(&source, &destination)
        })
        .unwrap_err();
        assert_eq!(calls, 10);
        assert!(matches!(error.raw_os_error(), Some(5 | 32 | 33)));
        assert_eq!(fs::read_to_string(&source).unwrap(), "NEW");
        assert_eq!(fs::read_to_string(&destination).unwrap(), "ORIGINAL");
        drop(reader);
    }
}
