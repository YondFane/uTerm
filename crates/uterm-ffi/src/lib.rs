use std::{
    cell::Cell,
    collections::HashMap,
    ffi::c_void,
    panic::{catch_unwind, AssertUnwindSafe},
    slice,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
};
use uterm_core::{Core, CoreError, MAX_REQUEST_BYTES};

#[repr(C)]
pub struct UTermBuffer {
    pub data: *const u8,
    pub length: usize,
    pub allocation: u64,
}
pub type Callback = unsafe extern "C" fn(*mut c_void, u64, *const u8, usize);
pub type TerminalCallback = unsafe extern "C" fn(*mut c_void, *const u8, usize) -> u32;
struct Client {
    core: Core,
    closing: AtomicBool,
    operations: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    idle: Condvar,
    subscriber: Mutex<Option<(Callback, usize)>>,
    terminal_subscriber: Mutex<Option<(TerminalCallback, usize)>>,
}
static NEXT: AtomicU64 = AtomicU64::new(1);
static CLIENTS: OnceLock<Mutex<HashMap<u64, Arc<Client>>>> = OnceLock::new();
static BUFFERS: OnceLock<Mutex<HashMap<u64, Box<[u8]>>>> = OnceLock::new();
thread_local! {static CALLBACK_CLIENT:Cell<u64>=const{Cell::new(0)};}
fn clients() -> &'static Mutex<HashMap<u64, Arc<Client>>> {
    CLIENTS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn buffers() -> &'static Mutex<HashMap<u64, Box<[u8]>>> {
    BUFFERS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn allocated(bytes: Vec<u8>) -> UTermBuffer {
    let bytes = bytes.into_boxed_slice();
    let result = UTermBuffer {
        data: bytes.as_ptr(),
        length: bytes.len(),
        allocation: NEXT.fetch_add(1, Ordering::Relaxed),
    };
    buffers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(result.allocation, bytes);
    result
}
fn error(code: &str, message: &str) -> Vec<u8> {
    serde_json::to_vec(
        &serde_json::json!({"version":1,"id":"","error":CoreError::new(code,message)}),
    )
    .unwrap_or_default()
}
fn guarded(action: impl FnOnce() -> Result<Vec<u8>, CoreError>) -> UTermBuffer {
    allocated(match catch_unwind(AssertUnwindSafe(action)) {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => error(&e.code, &e.message),
        Err(_) => error(
            "PANIC",
            "Core operation failed; panic was contained at the ABI boundary",
        ),
    })
}
unsafe fn input(data: *const u8, length: usize) -> Result<Vec<u8>, CoreError> {
    if length > MAX_REQUEST_BYTES || data.is_null() && length > 0 {
        return Err(CoreError::new("INVALID_BUFFER", "Invalid input buffer"));
    }
    if length == 0 {
        return Ok(Vec::new());
    }
    Ok(unsafe { slice::from_raw_parts(data, length) }.to_vec())
}
fn client(handle: u64) -> Result<Arc<Client>, CoreError> {
    clients()
        .lock()
        .map_err(|_| CoreError::new("STATE", "Client registry is unavailable"))?
        .get(&handle)
        .cloned()
        .filter(|c| !c.closing.load(Ordering::Acquire))
        .ok_or_else(|| CoreError::new("CLOSED", "Client is closed"))
}

#[no_mangle]
pub extern "C" fn uterm_abi_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn uterm_ssh_askpass() -> i32 {
    match catch_unwind(uterm_core::ssh::run_askpass_if_requested) {
        Ok(status) => status,
        _ => 1,
    }
}

#[no_mangle]
pub unsafe extern "C" fn uterm_open(
    root: *const u8,
    length: usize,
    handle: *mut u64,
) -> UTermBuffer {
    guarded(|| {
        if handle.is_null() {
            return Err(CoreError::new(
                "INVALID_BUFFER",
                "Handle output is required",
            ));
        }
        unsafe { handle.write(0) };
        let bytes = unsafe { input(root, length) }?;
        let root = std::str::from_utf8(&bytes)
            .map_err(|_| CoreError::new("INVALID_UTF8", "Data root is not UTF-8"))?;
        let path = std::path::PathBuf::from(root);
        if !path.is_absolute() {
            return Err(CoreError::new("INVALID_ROOT", "Data root must be absolute"));
        }
        let core = Core::open(path)?;
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let client = Arc::new(Client {
            core,
            closing: AtomicBool::new(false),
            operations: Mutex::new(HashMap::new()),
            idle: Condvar::new(),
            subscriber: Mutex::new(None),
            terminal_subscriber: Mutex::new(None),
        });
        let weak = Arc::downgrade(&client);
        client
            .core
            .set_terminal_sink(Arc::new(move |attachment, generation, frame| {
                let client = weak.upgrade().ok_or("Client is closed")?;
                if client.closing.load(Ordering::Acquire) {
                    return Err("Client is closed".into());
                }
                let bytes =
                    uterm_core::terminal::encode_frame(&frame, Some((attachment, generation)));
                let subscriber = client
                    .terminal_subscriber
                    .lock()
                    .map_err(|_| "Terminal subscription is unavailable")?;
                let Some((callback, context)) = *subscriber else {
                    return Err("Terminal consumer is unavailable".into());
                };
                CALLBACK_CLIENT.with(|handle| handle.set(id));
                let accepted =
                    unsafe { callback(context as *mut c_void, bytes.as_ptr(), bytes.len()) };
                CALLBACK_CLIENT.with(|handle| handle.set(0));
                if accepted == 1 {
                    Ok(())
                } else {
                    Err("Terminal consumer rejected the bounded frame".into())
                }
            }))?;
        clients()
            .lock()
            .map_err(|_| CoreError::new("STATE", "Client registry is unavailable"))?
            .insert(id, client);
        unsafe { handle.write(id) };
        Ok(serde_json::to_vec(
            &serde_json::json!({"version":1,"id":"","result":{"handle":id}}),
        )?)
    })
}
fn operate(
    client: &Client,
    handle: u64,
    action: impl FnOnce(u64) -> Result<Vec<u8>, CoreError>,
) -> Result<Vec<u8>, CoreError> {
    if CALLBACK_CLIENT.with(|id| id.get() == handle) {
        return Err(CoreError::new(
            "REENTRANT",
            "Schedule calls after the callback returns",
        ));
    }
    let mut operation = NEXT.fetch_add(1, Ordering::Relaxed);
    {
        let mut operations = client
            .operations
            .lock()
            .map_err(|_| CoreError::new("STATE", "Operation state is unavailable"))?;
        if client.closing.load(Ordering::Acquire) {
            return Err(CoreError::new("CLOSED", "Client is closed"));
        }
        while operations.contains_key(&operation) {
            operation = NEXT.fetch_add(1, Ordering::Relaxed);
        }
        operations.insert(operation, Arc::new(AtomicBool::new(false)));
    }
    let outcome = catch_unwind(AssertUnwindSafe(|| action(operation)));
    client
        .operations
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&operation);
    client.idle.notify_all();
    outcome.unwrap_or_else(|_| Err(CoreError::new("PANIC", "Core operation failed")))
}
#[no_mangle]
pub unsafe extern "C" fn uterm_call(handle: u64, request: *const u8, length: usize) -> UTermBuffer {
    guarded(|| {
        let client = client(handle)?;
        let bytes = unsafe { input(request, length) }?;
        operate(&client, handle, |operation| {
            let response = serde_json::to_vec(&client.core.execute(&bytes))?;
            publish(&client, handle, operation, &bytes, &response);
            Ok(response)
        })
    })
}
#[no_mangle]
pub extern "C" fn uterm_terminal_subscribe(
    handle: u64,
    callback: Option<TerminalCallback>,
    context: *mut c_void,
) -> u32 {
    catch_unwind(|| {
        if CALLBACK_CLIENT.with(|id| id.get() == handle) {
            return 0;
        }
        let Ok(client) = client(handle) else {
            return 0;
        };
        let Ok(mut subscriber) = client.terminal_subscriber.lock() else {
            return 0;
        };
        *subscriber = callback.map(|cb| (cb, context as usize));
        1
    })
    .unwrap_or(0)
}
#[no_mangle]
pub unsafe extern "C" fn uterm_terminal_write(
    handle: u64,
    attachment: *const u8,
    attachment_length: usize,
    data: *const u8,
    length: usize,
) -> UTermBuffer {
    guarded(|| {
        let client = client(handle)?;
        let name = unsafe { input(attachment, attachment_length) }?;
        let bytes = unsafe { input(data, length) }?;
        let name = std::str::from_utf8(&name)
            .map_err(|_| CoreError::new("INVALID_UTF8", "Attachment ID is not UTF-8"))?;
        operate(&client, handle, |_| {
            client.core.terminal_write(name, &bytes)?;
            Ok(serde_json::to_vec(
                &serde_json::json!({"version":1,"id":"","result":null}),
            )?)
        })
    })
}
fn publish(client: &Client, handle: u64, operation: u64, request: &[u8], response: &[u8]) {
    let Ok(request) = serde_json::from_slice::<uterm_core::Request>(request) else {
        return;
    };
    if !matches!(
        request.method.as_str(),
        "migration.import"
            | "control.execute"
            | "snapshot.replace"
            | "settings.patch"
            | "selection.set"
            | "recovery.restore"
    ) && !request.method.starts_with("workspace.")
        && !request.method.starts_with("project.")
        && !request.method.starts_with("session.")
        && !request.method.starts_with("settings.")
        && !request.method.starts_with("ssh.profile.")
        && !request.method.starts_with("ssh.session.")
    {
        return;
    }
    let Ok(response) = serde_json::from_slice::<serde_json::Value>(response) else {
        return;
    };
    let Some(revision) = response["result"]["revision"].as_str() else {
        return;
    };
    if client.closing.load(Ordering::Acquire) {
        return;
    }
    let subscriber = client.subscriber.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((callback, context)) = *subscriber {
        let event=serde_json::to_vec(&serde_json::json!({"version":1,"operationId":request.id,"kind":"snapshot.changed","revision":revision})).unwrap_or_default();
        CALLBACK_CLIENT.with(|id| id.set(handle));
        unsafe {
            callback(
                context as *mut c_void,
                operation,
                event.as_ptr(),
                event.len(),
            )
        };
        CALLBACK_CLIENT.with(|id| id.set(0));
    }
}
#[no_mangle]
pub extern "C" fn uterm_subscribe(
    handle: u64,
    callback: Option<Callback>,
    context: *mut c_void,
) -> u32 {
    catch_unwind(|| {
        if CALLBACK_CLIENT.with(|id| id.get() == handle) {
            return 0;
        }
        let Ok(client) = client(handle) else {
            return 0;
        };
        let Ok(mut subscriber) = client.subscriber.lock() else {
            return 0;
        };
        *subscriber = callback.map(|cb| (cb, context as usize));
        1
    })
    .unwrap_or(0)
}
#[no_mangle]
pub extern "C" fn uterm_buffer_release(allocation: u64) {
    let _ = catch_unwind(|| {
        buffers()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&allocation);
    });
}
#[no_mangle]
pub unsafe extern "C" fn uterm_request(
    handle: u64,
    operation: u64,
    request: *const u8,
    length: usize,
    callback: Option<Callback>,
    context: *mut c_void,
) -> u32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Ok(client) = client(handle) else {
            return 0;
        };
        let Some(callback) = callback else {
            return 0;
        };
        let Ok(bytes) = (unsafe { input(request, length) }) else {
            return 0;
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let Ok(mut operations) = client.operations.lock() else {
                return 0;
            };
            if client.closing.load(Ordering::Acquire) || operations.contains_key(&operation) {
                return 0;
            }
            operations.insert(operation, cancelled.clone());
        }
        let context = context as usize;
        let worker = client.clone();
        let started = std::thread::Builder::new()
            .name("uterm-core-operation".into())
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    if cancelled.load(Ordering::Acquire) || worker.closing.load(Ordering::Acquire) {
                        return Ok(error("CANCELLED", "Operation cancelled before execution"));
                    }
                    serde_json::to_vec(&worker.core.execute(&bytes))
                }));
                let response = match result {
                    Ok(Ok(bytes)) => bytes,
                    _ => error("PANIC", "Core worker failed"),
                };
                if !cancelled.load(Ordering::Acquire) && !worker.closing.load(Ordering::Acquire) {
                    publish(&worker, handle, operation, &bytes, &response);
                    CALLBACK_CLIENT.with(|id| id.set(handle));
                    unsafe {
                        callback(
                            context as *mut c_void,
                            operation,
                            response.as_ptr(),
                            response.len(),
                        )
                    };
                    CALLBACK_CLIENT.with(|id| id.set(0));
                }
                worker
                    .operations
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&operation);
                worker.idle.notify_all();
            });
        if started.is_err() {
            client
                .operations
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&operation);
            client.idle.notify_all();
            return 0;
        }
        1
    }))
    .unwrap_or(0)
}
#[no_mangle]
pub extern "C" fn uterm_cancel(handle: u64, operation: u64) -> u32 {
    catch_unwind(|| {
        let Ok(client) = client(handle) else {
            return 0;
        };
        let Ok(operations) = client.operations.lock() else {
            return 0;
        };
        let Some(cancelled) = operations.get(&operation) else {
            return 0;
        };
        cancelled.store(true, Ordering::Release);
        1
    })
    .unwrap_or(0)
}
#[no_mangle]
pub extern "C" fn uterm_close(handle: u64) -> u32 {
    catch_unwind(|| {
        if CALLBACK_CLIENT.with(|id| id.get() == handle) {
            return 0;
        }
        let client = {
            let Ok(mut clients) = clients().lock() else {
                return 0;
            };
            let Some(client) = clients.remove(&handle) else {
                return 0;
            };
            client
        };
        client.closing.store(true, Ordering::Release);
        client.core.close();
        let mut operations = client.operations.lock().unwrap_or_else(|e| e.into_inner());
        for cancelled in operations.values() {
            cancelled.store(true, Ordering::Release);
        }
        while !operations.is_empty() {
            operations = client
                .idle
                .wait(operations)
                .unwrap_or_else(|e| e.into_inner());
        }
        1
    })
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    mod control;
    fn consume(buffer: UTermBuffer) -> serde_json::Value {
        let result =
            serde_json::from_slice(unsafe { slice::from_raw_parts(buffer.data, buffer.length) })
                .unwrap();
        uterm_buffer_release(buffer.allocation);
        uterm_buffer_release(buffer.allocation);
        result
    }
    #[test]
    fn invalid_inputs_closed_handles_and_panics_are_contained() {
        assert!(
            consume(unsafe { uterm_open(std::ptr::null(), 1, std::ptr::null_mut()) })["error"]
                .is_object()
        );
        assert_eq!(
            consume(unsafe { uterm_call(999, std::ptr::null(), 0) })["error"]["code"],
            "CLOSED"
        );
        assert_eq!(
            consume(guarded(|| panic!("fixture panic")))["error"]["code"],
            "PANIC"
        );
    }
    unsafe extern "C" fn receive(
        context: *mut c_void,
        _operation: u64,
        data: *const u8,
        len: usize,
    ) {
        let sender = unsafe { &*(context as *const std::sync::mpsc::Sender<Vec<u8>>) };
        let _ = sender.send(unsafe { slice::from_raw_parts(data, len) }.to_vec());
    }
    #[test]
    fn asynchronous_calls_have_owned_input_and_close_drains_callbacks() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().to_str().unwrap().as_bytes();
        let mut handle = 0;
        assert!(
            consume(unsafe { uterm_open(root.as_ptr(), root.len(), &mut handle) })["result"]
                .is_object()
        );
        let (sender, receiver) = std::sync::mpsc::channel::<Vec<u8>>();
        let input = br#"{"version":1,"id":"async-1","method":"contract.info"}"#.to_vec();
        assert_eq!(
            unsafe {
                uterm_request(
                    handle,
                    1,
                    input.as_ptr(),
                    input.len(),
                    Some(receive),
                    &sender as *const _ as *mut c_void,
                )
            },
            1
        );
        drop(input);
        let response: serde_json::Value = serde_json::from_slice(
            &receiver
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["id"], "async-1");
        assert_eq!(response["result"]["version"], 1);
        assert_eq!(uterm_close(handle), 1);
        assert_eq!(uterm_close(handle), 0);
        assert_eq!(
            unsafe {
                uterm_request(
                    handle,
                    2,
                    std::ptr::null(),
                    0,
                    Some(receive),
                    &sender as *const _ as *mut c_void,
                )
            },
            0
        );
    }

    #[test]
    fn close_waits_for_an_active_callback_and_cancellation_does_not_free_context() {
        struct Context {
            started: std::sync::mpsc::Sender<()>,
            release: Mutex<std::sync::mpsc::Receiver<()>>,
        }
        unsafe extern "C" fn blocking(context: *mut c_void, _: u64, _: *const u8, _: usize) {
            let context = unsafe { &*(context as *const Context) };
            context.started.send(()).unwrap();
            context.release.lock().unwrap().recv().unwrap();
        }
        let root = tempfile::tempdir().unwrap();
        let bytes = root.path().to_str().unwrap().as_bytes();
        let mut handle = 0;
        consume(unsafe { uterm_open(bytes.as_ptr(), bytes.len(), &mut handle) });
        let (started, receive_started) = std::sync::mpsc::channel();
        let (release, receive_release) = std::sync::mpsc::channel();
        let context = Box::new(Context {
            started,
            release: Mutex::new(receive_release),
        });
        let request = br#"{"version":1,"id":"blocking","method":"contract.info"}"#;
        assert_eq!(
            unsafe {
                uterm_request(
                    handle,
                    42,
                    request.as_ptr(),
                    request.len(),
                    Some(blocking),
                    &*context as *const _ as *mut c_void,
                )
            },
            1
        );
        receive_started
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert_eq!(uterm_cancel(handle, 42), 1);
        let (closed, receive_closed) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            closed.send(uterm_close(handle)).unwrap();
        });
        assert!(receive_closed
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
        release.send(()).unwrap();
        assert_eq!(
            receive_closed
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            1
        );
        thread.join().unwrap();
        drop(context);
    }

    #[test]
    fn event_subscription_copies_bytes_and_rejects_reentrant_sync_calls() {
        struct Context {
            handle: u64,
            sender: std::sync::mpsc::Sender<serde_json::Value>,
        }
        unsafe extern "C" fn event(context: *mut c_void, _: u64, data: *const u8, length: usize) {
            let context = unsafe { &*(context as *const Context) };
            let event =
                serde_json::from_slice(unsafe { slice::from_raw_parts(data, length) }).unwrap();
            let reentrant = consume(unsafe { uterm_call(context.handle, std::ptr::null(), 0) });
            assert_eq!(reentrant["error"]["code"], "REENTRANT");
            assert_eq!(uterm_close(context.handle), 0);
            context.sender.send(event).unwrap();
        }
        let root = tempfile::tempdir().unwrap();
        let bytes = root.path().to_str().unwrap().as_bytes();
        let mut handle = 0;
        consume(unsafe { uterm_open(bytes.as_ptr(), bytes.len(), &mut handle) });
        let (sender, receiver) = std::sync::mpsc::channel();
        let context = Box::new(Context { handle, sender });
        assert_eq!(
            uterm_subscribe(handle, Some(event), &*context as *const _ as *mut c_void),
            1
        );
        let defaults = uterm_core::state::defaults();
        let request=serde_json::to_vec(&serde_json::json!({"version":1,"id":"migrate","method":"migration.import","params":{"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}}})).unwrap();
        let result = consume(unsafe { uterm_call(handle, request.as_ptr(), request.len()) });
        let event = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert_eq!(event["revision"], result["result"]["revision"]);
        assert_eq!(event["operationId"], "migrate");
        assert_eq!(uterm_subscribe(handle, None, std::ptr::null_mut()), 1);
        drop(context);
        assert_eq!(uterm_close(handle), 1);
    }
}

#[cfg(test)]
#[path = "tests/terminal.rs"]
mod terminal_tests;
