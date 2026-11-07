use super::*;
use std::{path::PathBuf, sync::mpsc, time::Duration};
use utermd_local::daemon::{Client as HostClient, Operation, Reply};

struct HostCleanup(PathBuf);
impl Drop for HostCleanup {
    fn drop(&mut self) {
        if let Ok(client) = HostClient::connect(&self.0) {
            if let Ok(Reply::HostStatus(status)) = client.request(Operation::HostStatus) {
                for session in status.sessions {
                    let _ = client.request(Operation::Close {
                        id: session.spec.id,
                        generation: session.generation,
                    });
                }
            }
            let _ = client.request(Operation::ShutdownIfIdle);
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while self.0.join("endpoint.json").exists() && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
}
fn result(buffer: UTermBuffer) -> serde_json::Value {
    let value =
        serde_json::from_slice(unsafe { slice::from_raw_parts(buffer.data, buffer.length) })
            .unwrap();
    uterm_buffer_release(buffer.allocation);
    value
}
fn call(handle: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    let bytes = serde_json::to_vec(
        &serde_json::json!({"version":1,"id":"terminal-lifetime","method":method,"params":params}),
    )
    .unwrap();
    let response = result(unsafe { uterm_call(handle, bytes.as_ptr(), bytes.len()) });
    assert!(response.get("error").is_none(), "{response}");
    response["result"].clone()
}
struct Context {
    handle: u64,
    started: mpsc::Sender<(Vec<u8>, bool)>,
    release: Mutex<mpsc::Receiver<()>>,
    count: std::sync::atomic::AtomicUsize,
}
unsafe extern "C" fn terminal(context: *mut c_void, bytes: *const u8, length: usize) -> u32 {
    let context = unsafe { &*(context as *const Context) };
    let owned = unsafe { slice::from_raw_parts(bytes, length) }.to_vec();
    let reentrant = result(unsafe { uterm_call(context.handle, std::ptr::null(), 0) });
    let protected = reentrant["error"]["code"] == "REENTRANT"
        && uterm_close(context.handle) == 0
        && uterm_terminal_subscribe(context.handle, None, std::ptr::null_mut()) == 0;
    context.count.fetch_add(1, Ordering::SeqCst);
    let _ = context.started.send((owned, protected));
    let _ = context.release.lock().unwrap().recv();
    1
}
struct Drain {
    handle: u64,
    release: mpsc::Sender<()>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Drain {
    fn drop(&mut self) {
        let _ = self.release.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        uterm_close(self.handle);
    }
}
#[test]
fn real_binary_callbacks_drain_before_unsubscribe_close_and_context_release() {
    let name = if cfg!(windows) {
        "utermd-local.exe"
    } else {
        "utermd-local"
    };
    let helper = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../utermd-local/target"))
        .join("debug")
        .join(name)
        .canonicalize()
        .expect("Build the standalone helper with pnpm test:core");
    for close in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let _host = HostCleanup(root.path().join("local-daemon-v1"));
        let state = root.path().join("shared-state-v1");
        let bytes = state.to_str().unwrap().as_bytes();
        let mut handle = 0;
        let opened = result(unsafe { uterm_open(bytes.as_ptr(), bytes.len(), &mut handle) });
        assert!(opened.get("error").is_none());
        let (started, receive_started) = mpsc::channel();
        let (release, receive_release) = mpsc::channel();
        let context = Box::new(Context {
            handle,
            started,
            release: Mutex::new(receive_release),
            count: std::sync::atomic::AtomicUsize::new(0),
        });
        // Drain is dropped before the borrowed context even if an assertion fails.
        // 即使断言失败，也先排空回调，再释放借用的上下文。
        let mut drain = Drain {
            handle,
            release,
            worker: None,
        };
        assert_eq!(
            uterm_terminal_subscribe(handle, Some(terminal), &*context as *const _ as *mut c_void),
            1
        );
        call(
            handle,
            "host.configure",
            serde_json::json!({"helper":helper}),
        );
        call(
            handle,
            "terminal.open",
            serde_json::json!({"id":"ffi-lifetime","attachment":"ffi-attachment","directory":root.path(),"shell":if cfg!(windows){"cmd"}else{"default"},"rows":24,"cols":80}),
        );
        let (owned, protected) = receive_started
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        assert!(protected);
        let length = u32::from_le_bytes(owned[..4].try_into().unwrap()) as usize;
        let header: uterm_core::terminal::TerminalHeader =
            serde_json::from_slice(&owned[4..4 + length]).unwrap();
        assert_eq!(header.attachment.as_deref(), Some("ffi-attachment"));
        let (finished, receive_finished) = mpsc::channel();
        drain.worker = Some(std::thread::spawn(move || {
            finished
                .send(if close {
                    uterm_close(handle)
                } else {
                    uterm_terminal_subscribe(handle, None, std::ptr::null_mut())
                })
                .unwrap();
        }));
        assert!(
            receive_finished
                .recv_timeout(Duration::from_millis(75))
                .is_err(),
            "Context must stay borrowed until callback completion"
        );
        drain.release.send(()).unwrap();
        assert_eq!(
            receive_finished
                .recv_timeout(Duration::from_secs(10))
                .unwrap(),
            1
        );
        drain.worker.take().unwrap().join().unwrap();
        assert_eq!(context.count.load(Ordering::SeqCst), 1);
        drop(drain);
        drop(context);
        assert_eq!(
            uterm_terminal_subscribe(handle, None, std::ptr::null_mut()),
            0
        );
        assert_eq!(uterm_close(handle), 0);
    }
}
