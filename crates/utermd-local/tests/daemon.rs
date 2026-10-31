use std::path::PathBuf;
use std::time::{Duration, Instant};
use utermd_local::daemon::{ensure_running, Client, Frame, Operation, Reply, SessionSpec};

struct RunningHost {
    directory: PathBuf,
    client: Client,
    sessions: Vec<(String, String)>,
}

#[test]
fn normal_stop_waits_for_child_cleanup_and_force_stop_remains_available() {
    use utermd_local::tasks::{Launch, Step, TaskInfo};
    let mut host = RunningHost::new();
    let root = host.directory.canonicalize().unwrap();
    for force in [false, true] {
        let id = if force {
            "force-cleanup"
        } else {
            "normal-cleanup"
        };
        let started = host.directory.join(format!("{id}.started"));
        let release = host.directory.join(format!("{id}.release"));
        let step = Step {
            program: std::env::current_exe().unwrap(),
            arguments: vec![
                "--exact".into(),
                "task_cleanup_child".into(),
                "--nocapture".into(),
            ],
            directory: root.clone(),
            environment: std::collections::HashMap::from([
                (
                    "TASK_CLEANUP_STARTED".into(),
                    started.to_string_lossy().into_owned(),
                ),
                (
                    "TASK_CLEANUP_RELEASE".into(),
                    release.to_string_lossy().into_owned(),
                ),
            ]),
            label: "Task cleanup".into(),
            jar_directory: None,
        };
        let next_step = Step {
            label: "UNEXPECTED_NEXT_STEP".into(),
            ..step.clone()
        };
        let Reply::Opened { generation } = host
            .client
            .request(Operation::OpenTask {
                spec: SessionSpec {
                    id: id.into(),
                    directory: root.clone(),
                    shell: "default".into(),
                    agent: None,
                    ssh: None,
                },
                task: TaskInfo {
                    root: root.clone(),
                    name: id.into(),
                    action: "python:run".into(),
                    created: u64::from(force),
                },
                launch: Launch {
                    root: root.clone(),
                    steps: vec![step, next_step],
                },
                rows: 24,
                cols: 80,
            })
            .unwrap()
        else {
            panic!("open cleanup task");
        };
        host.sessions.push((id.into(), generation.clone()));
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let frame = host.read(id, &generation, None);
            let text = String::from_utf8_lossy(&frame.data);
            if text.contains("CLEANUP_READY") {
                break;
            }
            assert!(!frame.exited, "cleanup task exited before startup: {text}");
            assert!(
                Instant::now() < deadline,
                "cleanup task did not start: {text}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        host.client
            .request(Operation::StopTask {
                id: id.into(),
                generation: generation.clone(),
                force: false,
            })
            .unwrap();
        while !started.exists() {
            let frame = host.read(id, &generation, None);
            let text = String::from_utf8_lossy(&frame.data);
            assert!(!frame.exited, "cleanup was terminated: {text}");
            assert!(
                Instant::now() < deadline,
                "cleanup did not receive interruption: {text}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            !host.read(id, &generation, None).exited,
            "cleanup was cut short"
        );
        let Reply::Tasks(tasks) = host.client.request(Operation::TaskSnapshot).unwrap() else {
            panic!("task snapshot");
        };
        assert!(tasks.iter().any(|task| task.spec.id == id && task.running));
        if force {
            host.client
                .request(Operation::StopTask {
                    id: id.into(),
                    generation: generation.clone(),
                    force: true,
                })
                .unwrap();
        } else {
            std::fs::write(&release, "finish").unwrap();
        }
        loop {
            let frame = host.read(id, &generation, None);
            let text = String::from_utf8_lossy(&frame.data);
            assert!(!text.contains("UNEXPECTED_NEXT_STEP"));
            if frame.exited {
                if force {
                    assert!(!text.contains("CLEANUP_FINISHED"));
                } else {
                    assert_eq!(frame.code, Some(0));
                    assert!(text.contains("CLEANUP_FINISHED"));
                    assert!(text.contains("CLEANUP_STDERR_FINISHED"));
                }
                break;
            }
            assert!(Instant::now() < deadline, "cleanup task did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn task_cleanup_child() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let Some(started) = std::env::var_os("TASK_CLEANUP_STARTED") else {
        return;
    };
    let release = PathBuf::from(std::env::var_os("TASK_CLEANUP_RELEASE").unwrap());
    static INTERRUPTED: AtomicBool = AtomicBool::new(false);
    #[cfg(windows)]
    unsafe extern "system" fn interrupt(event: u32) -> i32 {
        if event != 0 && event != 1 {
            return 0;
        }
        INTERRUPTED.store(true, Ordering::Release);
        1
    }
    #[cfg(windows)]
    assert_ne!(
        unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0) },
        0
    );
    #[cfg(windows)]
    assert_ne!(
        unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(interrupt), 1) },
        0
    );
    #[cfg(unix)]
    unsafe {
        extern "C" fn interrupt(_: libc::c_int) {
            INTERRUPTED.store(true, Ordering::Release);
        }
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = interrupt as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        assert_eq!(
            libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut()),
            0
        );
    }
    println!("CLEANUP_READY");
    while !INTERRUPTED.load(Ordering::Acquire) {
        std::thread::sleep(Duration::from_millis(20));
    }
    std::fs::write(started, "started").unwrap();
    while !release.exists() {
        std::thread::sleep(Duration::from_millis(20));
    }
    println!("CLEANUP_FINISHED");
    eprintln!("CLEANUP_STDERR_FINISHED");
}

#[test]
#[ignore = "Requires UTERM_PYTHON_TEST_INTERPRETER with FastAPI, Uvicorn, Flask and Django"]
fn python_tasks_stream_reconnect_and_terminate_web_reload_children() {
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use utermd_local::tasks::{Launch, Step, TaskInfo};
    let interpreter = PathBuf::from(std::env::var_os("UTERM_PYTHON_TEST_INTERPRETER").unwrap());
    let mut host = RunningHost::new();
    let root = host.directory.canonicalize().unwrap();
    std::fs::write(root.join("script 中文 & %.py"), "import sys\nprint('stdout 中文 & %PATH%')\nprint('stderr 中文',file=sys.stderr)\nraise RuntimeError('fixture-exception')\n").unwrap();
    std::fs::write(root.join("module_probe.py"), "print('MODULE_OK 中文')\n").unwrap();
    std::fs::write(root.join("fastapi_probe.py"), "from fastapi import FastAPI\napp=FastAPI()\n@app.get('/health')\ndef health(): return {'status':'PYTHON_QA_OK'}\n").unwrap();
    std::fs::write(root.join("flask_probe.py"), "from flask import Flask\napp=Flask(__name__)\n@app.get('/health')\ndef health(): return {'status':'PYTHON_QA_OK'}\n").unwrap();
    std::fs::write(root.join("manage.py"), "import sys\nfrom django.conf import settings\nsettings.configure(DEBUG=False,SECRET_KEY='isolated-fixture',ROOT_URLCONF=__name__,ALLOWED_HOSTS=['127.0.0.1'])\nfrom django.http import JsonResponse\nfrom django.urls import path\nurlpatterns=[path('health',lambda request:JsonResponse({'status':'PYTHON_QA_OK'}))]\nif __name__=='__main__':\n from django.core.management import execute_from_command_line\n execute_from_command_line(sys.argv)\n").unwrap();
    for (index, mode) in ["script", "module", "fastapi", "flask", "django"]
        .iter()
        .enumerate()
    {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut arguments: Vec<String> = vec!["-u".into()];
        arguments.extend(match *mode {
            "script" => vec![root
                .join("script 中文 & %.py")
                .to_string_lossy()
                .to_string()],
            "module" => vec!["-m".into(), "module_probe".into()],
            "fastapi" => vec![
                "-m".into(),
                "uvicorn".into(),
                "fastapi_probe:app".into(),
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                port.to_string(),
                "--reload".into(),
            ],
            "flask" => vec![
                "-m".into(),
                "flask".into(),
                "--app".into(),
                "flask_probe:app".into(),
                "run".into(),
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                port.to_string(),
                "--no-debugger".into(),
                "--reload".into(),
            ],
            _ => vec![
                root.join("manage.py").to_string_lossy().to_string(),
                "runserver".into(),
                format!("127.0.0.1:{port}"),
            ],
        });
        let spec = SessionSpec {
            id: format!("python-{mode}"),
            directory: root.clone(),
            shell: "default".into(),
            agent: None,
            ssh: None,
        };
        let Reply::Opened { generation } = host
            .client
            .request(Operation::OpenTask {
                spec: spec.clone(),
                task: TaskInfo {
                    root: root.clone(),
                    name: mode.to_string(),
                    action: "python:run".into(),
                    created: index as u64,
                },
                launch: Launch {
                    root: root.clone(),
                    steps: vec![Step {
                        program: interpreter.clone(),
                        arguments,
                        directory: root.clone(),
                        environment: HashMap::from([
                            ("PYTHONIOENCODING".into(), "utf-8".into()),
                            ("PYTHONUNBUFFERED".into(), "1".into()),
                        ]),
                        label: format!("Python {mode}"),
                        jar_directory: None,
                    }],
                },
                rows: 20,
                cols: 80,
            })
            .unwrap()
        else {
            panic!("open Python task");
        };
        host.sessions.push((spec.id.clone(), generation.clone()));
        let deadline = Instant::now() + Duration::from_secs(30);
        if index < 2 {
            loop {
                let frame = host.read(&spec.id, &generation, None);
                if frame.exited {
                    let text = String::from_utf8(frame.data).unwrap();
                    if index == 0 {
                        assert_eq!(frame.code, Some(1));
                        assert!(text.contains("stdout 中文 & %PATH%"), "{text}");
                        assert!(text.contains("stderr 中文"), "{text}");
                        assert!(text.contains("fixture-exception"), "{text}");
                    } else {
                        assert!(text.contains("MODULE_OK 中文"), "{text}");
                        assert_eq!(frame.code, Some(0));
                    }
                    break;
                }
                assert!(Instant::now() < deadline, "Python {mode} did not exit");
                std::thread::sleep(Duration::from_millis(30));
            }
        } else {
            loop {
                let response = (|| -> std::io::Result<String> {
                    let mut stream = TcpStream::connect_timeout(
                        &([127, 0, 0, 1], port).into(),
                        Duration::from_millis(200),
                    )?;
                    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                    stream.write_all(
                        b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                    )?;
                    let mut response = String::new();
                    stream.read_to_string(&mut response)?;
                    Ok(response)
                })();
                if response.is_ok_and(|text| text.contains("PYTHON_QA_OK")) {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "Python {mode}: {}",
                    String::from_utf8_lossy(&host.read(&spec.id, &generation, None).data)
                );
                std::thread::sleep(Duration::from_millis(100));
            }
            let reconnected = Client::connect(&host.directory).unwrap();
            assert!(
                matches!(reconnected.request(Operation::Attach { id: spec.id.clone(), rows: 25, cols: 90 }).unwrap(), Reply::Opened { generation: ref current } if current == &generation)
            );
            let text = String::from_utf8(host.read(&spec.id, &generation, None).data).unwrap();
            assert!(text.contains("health"), "{text}");
            assert!(host
                .client
                .request(Operation::StopTask {
                    id: spec.id.clone(),
                    generation: "stale".into(),
                    force: true
                })
                .is_err());
            host.client
                .request(Operation::StopTask {
                    id: spec.id.clone(),
                    generation: generation.clone(),
                    force: true,
                })
                .unwrap();
            loop {
                let frame = host.read(&spec.id, &generation, None);
                if frame.exited && TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok()
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "{mode} process tree or port remained alive"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let Reply::SessionSnapshot(snapshot) =
            host.client.request(Operation::SessionSnapshot).unwrap()
        else {
            panic!("snapshot");
        };
        assert!(snapshot.sessions.is_empty());
    }
}

#[test]
fn completed_task_drains_both_streams_before_publishing_exit() {
    use utermd_local::tasks::{Launch, Step, TaskInfo};
    let mut host = RunningHost::new();
    let root = host.directory.canonicalize().unwrap();
    #[cfg(windows)]
    let (program, arguments) = {
        let file = host.directory.join("final-output.ps1");
        std::fs::write(&file, "\u{feff}for ($i=0;$i -lt 2000;$i++) { [Console]::WriteLine('output-' + $i); [Console]::Error.WriteLine('error-' + $i) }; [Console]::WriteLine('FINAL_STDOUT_中文'); [Console]::Error.WriteLine('FINAL_STDERR_中文'); exit 7").unwrap();
        (
            PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-File".into(),
                file.to_string_lossy().into_owned(),
            ],
        )
    };
    #[cfg(unix)]
    let (program, arguments) = (PathBuf::from("/bin/sh"), vec!["-c".into(), "i=0; while [ $i -lt 2000 ]; do printf 'output-%s\\n' \"$i\"; printf 'error-%s\\n' \"$i\" >&2; i=$((i+1)); done; printf 'FINAL_STDOUT_中文\\n'; printf 'FINAL_STDERR_中文\\n' >&2; exit 7".into()]);
    let spec = SessionSpec {
        id: "completed-log".into(),
        directory: root.clone(),
        shell: "default".into(),
        agent: None,
        ssh: None,
    };
    let Reply::Opened { generation } = host
        .client
        .request(Operation::OpenTask {
            spec: spec.clone(),
            task: TaskInfo {
                root: root.clone(),
                name: "final-output".into(),
                action: "build".into(),
                created: 1,
            },
            launch: Launch {
                root: root.clone(),
                steps: vec![Step {
                    program,
                    arguments,
                    directory: root,
                    environment: Default::default(),
                    label: "Final output".into(),
                    jar_directory: None,
                }],
            },
            rows: 12,
            cols: 40,
        })
        .unwrap()
    else {
        panic!("open task")
    };
    host.sessions.push((spec.id.clone(), generation.clone()));
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let frame = host.read(&spec.id, &generation, None);
        if frame.exited {
            let text = String::from_utf8(frame.data).unwrap();
            assert_eq!(frame.code, Some(7), "{text}");
            assert!(text.contains("FINAL_STDOUT_中文"), "{text}");
            assert!(text.contains("FINAL_STDERR_中文"), "{text}");
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn structured_tasks_reconnect_keep_output_and_stay_out_of_shell_discovery() {
    use utermd_local::tasks::{Launch, Step, TaskInfo};
    let mut host = RunningHost::new();
    host.client.require_task_support().unwrap();
    let root = host.directory.canonicalize().unwrap();
    let argument = "literal & 100%PATH% 中文";
    let long_line = format!("LONG_LOG:{}:TAIL_中文", "x".repeat(2200));
    #[cfg(windows)]
    let (program, arguments) = {
        let file = host.directory.join("任务 & probe.ps1");
        std::fs::write(&file,format!("\u{feff}param([string]$Value)\n[Console]::WriteLine('TASK_READY:' + $Value)\n[Console]::WriteLine('{long_line}')\n[Console]::Error.WriteLine('STDERR_COMPLETE')\nwhile ($true) {{ Start-Sleep -Milliseconds 100 }}\n")).unwrap();
        (
            PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-File".into(),
                file.to_string_lossy().into_owned(),
                argument.into(),
            ],
        )
    };
    #[cfg(unix)]
    let (program, arguments) = {
        let file = host.directory.join("task & probe.sh");
        std::fs::write(&file, format!("printf 'TASK_READY:%s\\n' \"$1\"\nprintf '%s\\n' '{long_line}'\nprintf 'STDERR_COMPLETE\\n' >&2\nexec /bin/cat\n")).unwrap();
        (
            PathBuf::from("/bin/sh"),
            vec![file.to_string_lossy().into_owned(), argument.into()],
        )
    };
    let spec = SessionSpec {
        id: "java-task".into(),
        directory: root.clone(),
        shell: "default".into(),
        agent: None,
        ssh: None,
    };
    let task = TaskInfo {
        root: root.clone(),
        name: "fixture".into(),
        action: "run".into(),
        created: 1,
    };
    let launch = Launch {
        root: root.clone(),
        steps: vec![Step {
            program,
            arguments,
            directory: root,
            environment: Default::default(),
            label: "Task fixture".into(),
            jar_directory: None,
        }],
    };
    let Reply::Opened { generation } = host
        .client
        .request(Operation::OpenTask {
            spec: spec.clone(),
            task: task.clone(),
            launch: launch.clone(),
            rows: 24,
            cols: 100,
        })
        .unwrap()
    else {
        panic!("task open")
    };
    host.sessions.push((spec.id.clone(), generation.clone()));
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let frame = host.read(&spec.id, &generation, None);
        if String::from_utf8_lossy(&frame.data).contains(argument) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "{}",
            String::from_utf8_lossy(&frame.data)
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    for cols in [40, 220] {
        host.client
            .request(Operation::Resize {
                id: spec.id.clone(),
                generation: generation.clone(),
                rows: 12,
                cols,
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let frame = host.read(&spec.id, &generation, None);
            let text = String::from_utf8_lossy(&frame.data);
            if text.contains(&long_line) && text.contains("STDERR_COMPLETE") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "long stdout/stderr log missing after resize"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    let Reply::SessionSnapshot(snapshot) = host.client.request(Operation::SessionSnapshot).unwrap()
    else {
        panic!("snapshot")
    };
    assert!(snapshot.sessions.is_empty());
    assert!(host
        .client
        .request(Operation::OpenTask {
            spec: SessionSpec {
                id: "duplicate-java-task".into(),
                ..spec.clone()
            },
            task,
            launch,
            rows: 24,
            cols: 100,
        })
        .unwrap_err()
        .to_string()
        .contains("JAVA_TASK_RUNNING"));
    assert!(host
        .client
        .request(Operation::StopTask {
            id: spec.id.clone(),
            generation: "stale-generation".into(),
            force: true,
        })
        .is_err());
    assert!(host.client.request(Operation::ShutdownIfIdle).is_err());
    let Reply::HostStatus(status) = host.client.request(Operation::HostStatus).unwrap() else {
        panic!("host status")
    };
    assert!(status.sessions.iter().any(|entry| {
        entry.spec.id == spec.id && entry.generation == generation && entry.running
    }));
    let Reply::Opened {
        generation: reattached,
    } = host
        .client
        .request(Operation::Attach {
            id: spec.id.clone(),
            rows: 30,
            cols: 110,
        })
        .unwrap()
    else {
        panic!("attach")
    };
    assert_eq!(generation, reattached);
    assert!(host
        .client
        .request(Operation::Open {
            spec: spec.clone(),
            rows: 24,
            cols: 100
        })
        .is_err());
    host.client
        .request(Operation::StopTask {
            id: spec.id.clone(),
            generation: generation.clone(),
            force: true,
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let Reply::Tasks(tasks) = host.client.request(Operation::TaskSnapshot).unwrap() else {
            panic!("tasks")
        };
        if !tasks[0].running {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        String::from_utf8_lossy(&host.read(&spec.id, &generation, None).data)
            .contains("TASK_READY")
    );
    assert!(host.read(&spec.id, &generation, None).error.is_none());
    assert!(host
        .client
        .request(Operation::Attach {
            id: "missing-task".into(),
            rows: 24,
            cols: 80
        })
        .is_err());
}
impl RunningHost {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("uterm-host-test-{}", uuid::Uuid::new_v4()));
        let client = ensure_running(
            &directory,
            std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
        )
        .expect("start host");
        Self {
            directory,
            client,
            sessions: vec![],
        }
    }
    fn open(&mut self, id: &str) -> String {
        let spec = SessionSpec {
            ssh: None,
            id: id.into(),
            directory: self.directory.clone(),
            shell: "default".into(),
            agent: None,
        };
        match self
            .client
            .request(Operation::Open {
                spec,
                rows: 24,
                cols: 80,
            })
            .expect("open")
        {
            Reply::Opened { generation } => {
                self.sessions.push((id.into(), generation.clone()));
                generation
            }
            reply => panic!("{reply:?}"),
        }
    }
    fn write(&self, id: &str, generation: &str, data: &str) {
        self.client
            .request(Operation::Write {
                id: id.into(),
                generation: generation.into(),
                data: data.as_bytes().to_vec(),
            })
            .expect("write");
    }
    fn read(&self, id: &str, generation: &str, after: Option<u64>) -> Frame {
        match self
            .client
            .request(Operation::Read {
                id: id.into(),
                generation: generation.into(),
                after,
            })
            .expect("read")
        {
            Reply::Frame(frame) => frame,
            reply => panic!("{reply:?}"),
        }
    }
    #[cfg(unix)]
    fn until(&self, id: &str, generation: &str, expected: &str) -> Frame {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let frame = self.read(id, generation, None);
            if String::from_utf8_lossy(&frame.data).contains(expected) {
                return frame;
            }
            assert!(
                Instant::now() < deadline,
                "missing {expected}: {}",
                String::from_utf8_lossy(&frame.data)
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
impl Drop for RunningHost {
    fn drop(&mut self) {
        for (id, generation) in &self.sessions {
            if let Err(error) = self.client.request(Operation::Close {
                id: id.clone(),
                generation: generation.clone(),
            }) {
                eprintln!("test cleanup: {error}");
            }
        }
        if let Err(error) = self.client.request(Operation::ShutdownIfEmpty) {
            eprintln!("test shutdown: {error}");
        }
        std::thread::sleep(Duration::from_millis(100));
        if let Err(error) = std::fs::remove_dir_all(&self.directory) {
            eprintln!("test directory cleanup: {error}");
        }
    }
}

#[test]
fn local_discovery_does_not_keep_closed_sessions() {
    let mut host = RunningHost::new();
    let generation = host.open("discovered");
    let Reply::Sessions(sessions) = host.client.request(Operation::ListSessions).unwrap() else {
        panic!("session list reply");
    };
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "discovered");
    host.client
        .request(Operation::Close {
            id: "discovered".into(),
            generation,
        })
        .unwrap();
    host.sessions.clear();
    let Reply::Sessions(sessions) = host.client.request(Operation::ListSessions).unwrap() else {
        panic!("session list reply");
    };
    assert!(sessions.is_empty());
    let Reply::SessionSnapshot(snapshot) = host.client.request(Operation::SessionSnapshot).unwrap()
    else {
        panic!("session snapshot reply");
    };
    assert!(snapshot.sessions.is_empty());
    assert!(snapshot.closed.iter().any(|id| id == "discovered"));
}

#[test]
fn session_requires_an_explicit_existing_directory() {
    let host = RunningHost::new();
    for directory in [PathBuf::new(), host.directory.join("missing")] {
        assert!(host
            .client
            .request(Operation::Open {
                spec: SessionSpec {
                    ssh: None,
                    id: "invalid-directory".into(),
                    directory,
                    shell: "default".into(),
                    agent: None,
                },
                rows: 24,
                cols: 80,
            })
            .is_err());
    }
    let Reply::HostStatus(status) = host.client.request(Operation::HostStatus).unwrap() else {
        panic!("host status");
    };
    assert!(status.sessions.is_empty());
}

#[test]
fn host_management_refuses_live_sessions_and_restarts_after_exit() {
    let mut host = RunningHost::new();
    let generation = host.open("managed");
    let Reply::HostStatus(status) = host.client.request(Operation::HostStatus).unwrap() else {
        panic!("host status");
    };
    assert_eq!(status.sessions.len(), 1);
    assert_eq!(status.sessions[0].generation, generation);
    assert!(status.sessions[0].running);
    assert!(host.client.request(Operation::ShutdownIfIdle).is_err());
    assert_eq!(host.open("managed"), generation);
    assert!(host
        .client
        .request(Operation::Close {
            id: "managed".into(),
            generation: "stale".into()
        })
        .is_err());
    host.write("managed", &generation, "exit\r");
    let deadline = Instant::now() + Duration::from_secs(15);
    while !host.read("managed", &generation, None).exited {
        assert!(Instant::now() < deadline, "shell did not exit");
        std::thread::sleep(Duration::from_millis(50));
    }
    let Reply::HostStatus(exited) = host.client.request(Operation::HostStatus).unwrap() else {
        panic!("host status");
    };
    assert!(!exited.sessions[0].running);
    host.client.request(Operation::ShutdownIfIdle).unwrap();
    host.sessions.clear();
    let deadline = Instant::now() + Duration::from_secs(5);
    while host.directory.join("endpoint.json").exists() {
        assert!(Instant::now() < deadline, "host did not stop");
        std::thread::sleep(Duration::from_millis(50));
    }
    host.client = ensure_running(
        &host.directory,
        std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
    )
    .unwrap();
    let Reply::HostStatus(restarted) = host.client.request(Operation::HostStatus).unwrap() else {
        panic!("host status");
    };
    assert_ne!(restarted.pid, status.pid);
    assert!(restarted.sessions.is_empty());
}

#[test]
fn startup_is_singleton_and_does_not_accept_stale_generations() {
    let mut host = RunningHost::new();
    let first = host.client.request(Operation::Ping).expect("ping");
    let second = ensure_running(
        &host.directory,
        std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
    )
    .expect("reconnect")
    .request(Operation::Ping)
    .expect("ping");
    match (first, second) {
        (Reply::Ready { pid: a, .. }, Reply::Ready { pid: b, .. }) => assert_eq!(a, b),
        _ => panic!("ping"),
    }
    let generation = host.open("one");
    assert_eq!(host.open("one"), generation);
    assert!(host
        .client
        .request(Operation::Close {
            id: "one".into(),
            generation: "stale".into()
        })
        .is_err());
    assert!(host.client.request(Operation::ShutdownIfEmpty).is_err());
}

#[cfg(unix)]
#[test]
fn reconnect_preserves_process_environment_output_and_exit() {
    let mut host = RunningHost::new();
    let generation = host.open("persist");
    host.write("persist", &generation, "export UTERM_DURABLE_MARKER=durable; printf 'pid=%s\\n' \"$$\" > pid.txt; printf 'first:%s\\n' \"$UTERM_DURABLE_MARKER\"\n");
    host.until("persist", &generation, "first:durable");
    let pid = std::fs::read_to_string(host.directory.join("pid.txt")).expect("pid");
    let reconnected = ensure_running(
        &host.directory,
        std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
    )
    .expect("reconnect");
    host.client = reconnected;
    assert_eq!(host.open("persist"), generation);
    host.write(
        "persist",
        &generation,
        "printf 'after:%s pid=%s\\n' \"$UTERM_DURABLE_MARKER\" \"$$\"\n",
    );
    let frame = host.until("persist", &generation, "after:durable");
    assert!(frame.reset);
    assert!(String::from_utf8_lossy(&frame.data).contains(pid.trim()));
    host.write("persist", &generation, "exit 7\n");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let frame = host.read("persist", &generation, None);
        if frame.exited {
            assert_eq!(frame.code, Some(7));
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        host.open("persist"),
        generation,
        "reopening an exited session must not launch a new shell"
    );
}

#[cfg(unix)]
#[test]
fn unattended_output_does_not_block_and_close_only_ends_its_session() {
    let mut host = RunningHost::new();
    let first = host.open("flood");
    let second = host.open("other");
    host.write(
        "flood",
        &first,
        "yes 'background output 中文' | head -n 70000; printf 'flood-complete\\n' > complete.txt\n",
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    while !host.directory.join("complete.txt").exists() {
        assert!(Instant::now() < deadline, "unattended output blocked");
        std::thread::sleep(Duration::from_millis(50));
    }
    let frame = host.read("flood", &first, Some(0));
    assert!(frame.reset, "lagging clients receive a bounded snapshot");
    assert!(frame.data.len() < 1024 * 1024);
    host.client
        .request(Operation::Close {
            id: "flood".into(),
            generation: first,
        })
        .expect("close");
    host.write("other", &second, "printf 'other-alive\\n'\n");
    host.until("other", &second, "other-alive");
}

#[cfg(unix)]
#[test]
fn client_process_exit_keeps_shell_and_background_work_alive() {
    const CHILD_DIRECTORY: &str = "UTERM_TEST_CLIENT_STATE";
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        let directory = PathBuf::from(directory);
        let client = ensure_running(
            &directory,
            std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
        )
        .expect("child starts host");
        let spec = SessionSpec {
            ssh: None,
            id: "parent-exit".into(),
            directory: directory.clone(),
            shell: "default".into(),
            agent: None,
        };
        let Reply::Opened { generation } = client
            .request(Operation::Open {
                spec,
                rows: 24,
                cols: 80,
            })
            .expect("open")
        else {
            panic!("open reply")
        };
        client.request(Operation::Write { id: "parent-exit".into(), generation: generation.clone(), data: b"export UTERM_PARENT_EXIT=kept; sleep 1; printf 'continued-after-client-exit\\n' > background.txt\n".to_vec() }).expect("launch background task");
        std::fs::write(directory.join("generation.txt"), generation).expect("save generation");
        return;
    }
    let directory =
        std::env::temp_dir().join(format!("uterm-client-exit-{}", uuid::Uuid::new_v4()));
    let status = std::process::Command::new(std::env::current_exe().expect("test executable"))
        .args([
            "--exact",
            "client_process_exit_keeps_shell_and_background_work_alive",
            "--nocapture",
        ])
        .env(CHILD_DIRECTORY, &directory)
        .status()
        .expect("child client");
    assert!(status.success());
    let client = Client::connect(&directory).expect("host survives parent process exit");
    let generation = std::fs::read_to_string(directory.join("generation.txt")).expect("generation");
    let host = RunningHost {
        directory,
        client,
        sessions: vec![("parent-exit".into(), generation.clone())],
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !host.directory.join("background.txt").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(50));
    }
    host.write(
        "parent-exit",
        &generation,
        "printf 'retained:%s\\n' \"$UTERM_PARENT_EXIT\"\n",
    );
    host.until("parent-exit", &generation, "retained:kept");
}

#[cfg(unix)]
#[test]
fn terminal_queries_are_answered_without_a_connected_renderer() {
    let mut host = RunningHost::new();
    let generation = host.open("query");
    host.write("query", &generation, "stty -echo -icanon min 0 time 20; printf '\\033[6n'; dd bs=1 count=8 2>/dev/null > reply.txt; stty sane; printf 'query-finished\\n' > query-done.txt\n");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !host.directory.join("query-done.txt").exists() {
        assert!(Instant::now() < deadline, "query blocked without renderer");
        std::thread::sleep(Duration::from_millis(50));
    }
    let reply = std::fs::read(host.directory.join("reply.txt")).expect("query response");
    assert!(reply.starts_with(b"\x1b["));
    assert!(reply.contains(&b'R'), "{reply:?}");
}

#[test]
fn connection_waits_for_delayed_request_bytes() {
    use std::io::{Read, Write};
    let host = RunningHost::new();
    let endpoint: serde_json::Value = serde_json::from_slice(
        &std::fs::read(host.directory.join("endpoint.json")).expect("endpoint"),
    )
    .expect("endpoint JSON");
    let mut stream = std::net::TcpStream::connect((
        "127.0.0.1",
        endpoint["port"].as_u64().expect("port") as u16,
    ))
    .expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("timeout");
    // accept() inherits O_NONBLOCK on macOS; the server must wait for request bytes.
    // macOS 的 accept() 会继承 O_NONBLOCK；服务端必须等待请求字节到达。
    std::thread::sleep(Duration::from_millis(100));
    let request = serde_json::to_vec(&serde_json::json!({
        "version": 1, "token": endpoint["token"], "operation": "Ping"
    }))
    .expect("request");
    stream
        .write_all(&(request.len() as u32).to_be_bytes())
        .expect("length");
    std::thread::sleep(Duration::from_millis(50));
    stream.write_all(&request).expect("body");
    let mut length = [0; 4];
    stream.read_exact(&mut length).expect("response length");
    let mut response = vec![0; u32::from_be_bytes(length) as usize];
    stream.read_exact(&mut response).expect("response");
    assert!(matches!(
        serde_json::from_slice::<Reply>(&response).expect("reply"),
        Reply::Ready { .. }
    ));
}

#[test]
fn agent_reports_survive_reattachment_and_reject_stale_generations() {
    let mut host = RunningHost::new();
    let generation = host.open("agent-reports");
    for state in ["working", "waiting", "done"] {
        host.client
            .request(Operation::Report {
                id: "agent-reports".into(),
                generation: generation.clone(),
                state: state.into(),
            })
            .expect("report");
        let restored = Client::connect(&host.directory).expect("reattach");
        match restored
            .request(Operation::Read {
                id: "agent-reports".into(),
                generation: generation.clone(),
                after: None,
            })
            .expect("read")
        {
            Reply::Frame(frame) => assert_eq!(frame.agent_state.as_deref(), Some(state)),
            reply => panic!("{reply:?}"),
        }
    }
    assert!(host
        .client
        .request(Operation::Report {
            id: "agent-reports".into(),
            generation: "stale".into(),
            state: "working".into()
        })
        .is_err());
    assert!(host
        .client
        .request(Operation::Report {
            id: "agent-reports".into(),
            generation,
            state: "invalid".into()
        })
        .is_err());
}

#[cfg(unix)]
#[test]
fn custom_agent_arguments_and_reporter_environment_reach_the_daemon() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("uterm-custom-agent-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("root");
    let program = root.join("custom agent.sh");
    std::fs::write(&program, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n\"$UTERM_DESKTOP_REPORTER\" --agent-report done </dev/null\nsleep 20\n").expect("program");
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).expect("executable");
    let definitions = serde_json::json!([{"id":"custom","name":"Custom","program":program,"arguments":["argument with spaces", "$(echo not-executed)"]}]);
    std::fs::write(
        root.join("agents.json"),
        serde_json::to_vec(&definitions).expect("JSON"),
    )
    .expect("config");
    let directory = root.join("host");
    let client = ensure_running(
        &directory,
        std::path::Path::new(env!("CARGO_BIN_EXE_utermd-local")),
    )
    .expect("host");
    client.require_agent_support().expect("agent support");
    let Reply::Opened { generation } = client
        .request(Operation::Open {
            spec: SessionSpec {
                ssh: None,
                id: "custom-session".into(),
                directory: root.clone(),
                shell: "default".into(),
                agent: Some("custom".into()),
            },
            rows: 24,
            cols: 80,
        })
        .expect("open")
    else {
        panic!("opened");
    };
    let host = RunningHost {
        directory,
        client,
        sessions: vec![("custom-session".into(), generation.clone())],
    };
    let frame = host.until("custom-session", &generation, "$(echo not-executed)");
    assert!(String::from_utf8_lossy(&frame.data).contains("argument with spaces"));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if host
            .read("custom-session", &generation, None)
            .agent_state
            .as_deref()
            == Some("done")
        {
            break;
        }
        assert!(Instant::now() < deadline, "reporter did not reach daemon");
        std::thread::sleep(Duration::from_millis(25));
    }
    drop(host);
    std::fs::remove_dir_all(root).expect("cleanup");
}

#[cfg(unix)]
#[test]
fn alternate_screen_and_resize_survive_renderer_reattachment() {
    let mut host = RunningHost::new();
    let generation = host.open("full-screen");
    host.write(
        "full-screen",
        &generation,
        "stty -echo; touch screen-ready.txt\n",
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !host.directory.join("screen-ready.txt").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(25));
    }
    host.write("full-screen", &generation, "printf '\\033[?1049h\\033[2J\\033[5;8Hfullscreen-marker'; sleep 2; printf '\\033[?1049l'\n");
    let frame = host.until("full-screen", &generation, "fullscreen-marker");
    assert!(frame.data.windows(8).any(|part| part == b"\x1b[?1049h"));
    host.client
        .request(Operation::Resize {
            id: "full-screen".into(),
            generation: generation.clone(),
            rows: 30,
            cols: 100,
        })
        .expect("resize");
    let resized = host.read("full-screen", &generation, None);
    assert_eq!((resized.rows, resized.cols), (30, 100));
}

#[test]
fn update_preflight_rejects_unmanaged_and_unreachable_hosts_without_stopping_sessions() {
    use utermd_local::daemon::ensure_update_safe;
    let mut host = RunningHost::new();
    let generation = host.open("update-guard");
    assert!(ensure_update_safe(&host.directory).is_err());
    assert_eq!(host.open("update-guard"), generation);
    let endpoint = host.directory.join("endpoint.json");
    let original = std::fs::read(&endpoint).expect("read endpoint");
    std::fs::write(&endpoint, b"invalid").expect("corrupt endpoint");
    assert!(ensure_update_safe(&host.directory).is_err());
    std::fs::write(endpoint, original).expect("restore endpoint");
    assert_eq!(host.open("update-guard"), generation);
}

#[test]
fn detached_host_allows_updates_and_survives_installation_replacement() {
    use utermd_local::daemon::ensure_update_safe;
    let root = std::env::temp_dir().join(format!("uterm-update-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("root");
    let installed = root.join(if cfg!(windows) { "uTerm.exe" } else { "uTerm" });
    let detached = root.join(if cfg!(windows) {
        "uterm-session-host.exe"
    } else {
        "uterm-session-host"
    });
    std::fs::copy(env!("CARGO_BIN_EXE_utermd-local"), &installed).expect("install");
    std::fs::copy(&installed, &detached).expect("detach executable");
    let directory = root.join("state");
    ensure_update_safe(&directory).expect("no host");
    let client = ensure_running(&directory, &detached).expect("host");
    let mut host = RunningHost {
        directory,
        client,
        sessions: vec![],
    };
    let generation = host.open("update-session");
    ensure_update_safe(&host.directory).expect("detached host is safe");
    std::fs::remove_file(&installed).expect("remove old installation");
    std::fs::write(&installed, b"new app version").expect("replace installation");
    host.client = Client::connect(&host.directory).expect("reconnect after update");
    assert_eq!(host.open("update-session"), generation);
    #[cfg(unix)]
    {
        host.write(
            "update-session",
            &generation,
            "printf 'alive-after-update\\n'\n",
        );
        host.until("update-session", &generation, "alive-after-update");
    }
    drop(host);
    let deadline = Instant::now() + Duration::from_secs(5);
    while let Err(error) = std::fs::remove_dir_all(&root) {
        assert!(Instant::now() < deadline, "cleanup: {error}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
#[test]
fn ssh_protocol_helper() {
    let Some(root) = std::env::var_os("UTERM_TEST_SSH_PROTOCOL") else {
        return;
    };
    let mut host = RunningHost::new();
    host.client.require_ssh_support().unwrap();
    host.client.require_ssh_config_support().unwrap();
    let spec = SessionSpec {
        id: "ssh".into(),
        directory: PathBuf::from(root),
        shell: "default".into(),
        agent: None,
        ssh: Some(utermd_local::ssh::SshTarget {
            connection_id: "connection".into(),
            workspace_id: "workspace".into(),
            name: "Remote".into(),
            host: "fixture".into(),
            os: "posix".into(),
            root: "/remote".into(),
            ..Default::default()
        }),
    };
    assert!(host
        .client
        .request(Operation::Open {
            spec: spec.clone(),
            rows: 24,
            cols: 80
        })
        .is_err());
    assert!(host
        .client
        .request(Operation::OpenSsh {
            spec: spec.clone(),
            rows: 24,
            cols: 80,
            create: false
        })
        .unwrap_err()
        .to_string()
        .contains("SSH_SESSION_MISSING"));
    let Reply::Opened { generation } = host
        .client
        .request(Operation::OpenSsh {
            spec: spec.clone(),
            rows: 24,
            cols: 80,
            create: true,
        })
        .unwrap()
    else {
        panic!("SSH open");
    };
    host.sessions.push((spec.id.clone(), generation.clone()));
    host.until("ssh", &generation, "SSH_FIXTURE_READY");
    let Reply::SessionSnapshot(local) = host.client.request(Operation::SessionSnapshot).unwrap()
    else {
        panic!("local snapshot");
    };
    assert!(local.sessions.is_empty());
    let Reply::SshSessionSnapshot(snapshot) =
        host.client.request(Operation::SshSessionSnapshot).unwrap()
    else {
        panic!("SSH snapshot");
    };
    assert_eq!(snapshot.sessions, vec![spec.clone()]);
    let Reply::Opened {
        generation: reattached,
    } = host
        .client
        .request(Operation::OpenSsh {
            spec: spec.clone(),
            rows: 40,
            cols: 100,
            create: false,
        })
        .unwrap()
    else {
        panic!("reattach");
    };
    assert_eq!(reattached, generation);
    host.write("ssh", &generation, "replay-after-attach\r");
    host.until("ssh", &generation, "replay-after-attach");
    assert!(host
        .client
        .request(Operation::Close {
            id: "ssh".into(),
            generation: "stale".into()
        })
        .is_err());
    host.client
        .request(Operation::Close {
            id: "ssh".into(),
            generation,
        })
        .unwrap();
    host.sessions.clear();
    assert!(host
        .client
        .request(Operation::OpenSsh {
            spec,
            rows: 24,
            cols: 80,
            create: true
        })
        .is_err());
    let mut configured = snapshot.sessions[0].clone();
    configured.id = "ssh-configured".into();
    let target = configured.ssh.as_mut().unwrap();
    target.mode = Some("direct".into());
    target.port = Some(2222);
    target.username = Some("qa".into());
    let Reply::Opened { generation } = host
        .client
        .request(Operation::OpenSshConfigured {
            spec: configured,
            rows: 24,
            cols: 80,
            resolved: utermd_local::ssh::ResolvedTarget {
                hostname: "127.0.0.1".into(),
                user: "qa".into(),
                port: 2222,
            },
            askpass: None,
        })
        .unwrap()
    else {
        panic!("configured SSH open");
    };
    host.sessions
        .push(("ssh-configured".into(), generation.clone()));
    host.until("ssh-configured", &generation, "SSH_FIXTURE_READY");
}

#[cfg(unix)]
#[test]
fn ssh_sessions_are_isolated_from_local_discovery_and_keep_identity_on_attach() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("uterm-ssh-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let program = root.join("ssh");
    std::fs::write(
        &program,
        "#!/bin/sh\nprintf 'SSH_FIXTURE_READY\\n'\nexec /bin/cat\n",
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut path = vec![root.clone()];
    path.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "ssh_protocol_helper", "--nocapture"])
        .env("UTERM_TEST_SSH_PROTOCOL", &root)
        .env("PATH", std::env::join_paths(path).unwrap())
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(root);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
