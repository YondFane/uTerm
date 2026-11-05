use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use utermd_local::daemon::{Client, Frame, Operation, Reply};

#[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct ActivityEvent {
    pub id: String,
    pub sequence: u64,
    pub kind: String,
    pub source: String,
}
#[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct InputControl {
    pub owned: bool,
    pub owner: Option<String>,
}
#[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct TerminalHeader {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_control: Option<InputControl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    pub agent_state: Option<String>,
    pub agent_events: Option<Vec<ActivityEvent>>,
    pub agent_activity_error: Option<String>,
    pub foreground_agent: Option<String>,
    pub sequence: u64,
    pub reset: bool,
    pub rows: u16,
    pub cols: u16,
    pub exited: bool,
    pub code: Option<u32>,
    pub error: Option<String>,
}

pub fn parse_sequence(value: &serde_json::Value) -> Result<u64, String> {
    if let Some(number) = value.as_u64() {
        return Ok(number);
    }
    if let Some(text) = value.as_str() {
        if !text.is_empty()
            && text.len() <= 20
            && (text == "0" || !text.starts_with('0'))
            && text.bytes().all(|b| b.is_ascii_digit())
        {
            return text.parse().map_err(|_| "Invalid terminal sequence".into());
        }
    }
    Err("Invalid terminal sequence".into())
}

pub type Sink = Arc<dyn Fn(&str, &str, Frame) -> Result<(), String> + Send + Sync>;
pub struct Link {
    pub session: String,
    pub generation: String,
    pub client: Client,
    stopped: AtomicBool,
    pending: Mutex<Option<u64>>,
    acknowledged: Condvar,
}
impl Link {
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.acknowledged.notify_all();
    }
    pub fn stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
}
impl Drop for Link {
    fn drop(&mut self) {
        if let Err(error) = self.client.release_control(&self.session, &self.generation) {
            eprintln!("Input control cleanup: {error:#}");
        }
    }
}
#[derive(Default)]
struct Registry {
    links: HashMap<String, Arc<Link>>,
    active: usize,
    closed: bool,
}
#[derive(Default)]
pub struct Links {
    registry: Mutex<Registry>,
    idle: Condvar,
}
struct Worker {
    links: Arc<Links>,
    attachment: String,
    link: Arc<Link>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.link.stop();
        if let Err(error) = self
            .link
            .client
            .release_control(&self.link.session, &self.link.generation)
        {
            eprintln!("Input control cleanup: {error:#}");
        }
        let mut state = self
            .links
            .registry
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state
            .links
            .get(&self.attachment)
            .is_some_and(|link| Arc::ptr_eq(link, &self.link))
        {
            state.links.remove(&self.attachment);
        }
        state.active -= 1;
        self.links.idle.notify_all();
    }
}
impl Links {
    pub fn get(&self, attachment: &str) -> Result<Arc<Link>, String> {
        self.registry
            .lock()
            .map_err(|e| e.to_string())?
            .links
            .get(attachment)
            .cloned()
            .ok_or_else(|| "Session is disconnected".into())
    }
    pub fn find(&self, session: &str) -> Result<Arc<Link>, String> {
        self.registry
            .lock()
            .map_err(|e| e.to_string())?
            .links
            .values()
            .filter(|link| link.session == session && !link.stopped())
            .max_by_key(|link| link.client.has_input_control())
            .cloned()
            .ok_or_else(|| "会话尚未连接，请稍后重试。".into())
    }
    pub fn remove(&self, attachment: &str, expected: &Arc<Link>) -> Result<(), String> {
        let mut state = self.registry.lock().map_err(|e| e.to_string())?;
        // A late close must not remove the replacement attachment.
        // 迟到的关闭不能移除重连后的新链路。
        if state
            .links
            .get(attachment)
            .is_some_and(|link| Arc::ptr_eq(link, expected))
        {
            state.links.remove(attachment);
        }
        Ok(())
    }
    pub fn detach(&self) {
        let mut state = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        for (_, link) in state.links.drain() {
            link.stop();
        }
    }
    pub fn stop_session(&self, id: &str) {
        let mut state = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        state.links.retain(|_, link| {
            if link.session == id {
                link.stop();
                false
            } else {
                true
            }
        });
    }
    pub fn shutdown(&self) {
        let mut state = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        for (_, link) in state.links.drain() {
            link.stop();
        }
        while state.active > 0 {
            state = self.idle.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }
    pub fn open(
        self: &Arc<Self>,
        client: Client,
        operation: Operation,
        session: String,
        attachment: String,
        rows: u16,
        cols: u16,
        sink: Sink,
    ) -> Result<String, String> {
        if self.registry.lock().map_err(|e| e.to_string())?.closed {
            return Err("Client is closed".into());
        }
        {
            let state = self.registry.lock().map_err(|e| e.to_string())?;
            if state.links.len() >= 128 && !state.links.contains_key(&attachment) {
                return Err("Terminal attachment limit reached".into());
            }
        }
        let task_only = matches!(&operation, Operation::Attach { .. });
        let client = if task_only {
            client
        } else {
            client
                .for_view("uTerm")
                .map_err(|error| format!("{error:#}"))?
        };
        let generation = match client.request(operation).map_err(|e| format!("{e:#}"))? {
            Reply::Opened { generation } => generation,
            _ => return Err("Invalid session response".into()),
        };
        let link = Arc::new(Link {
            session,
            generation: generation.clone(),
            client,
            stopped: AtomicBool::new(false),
            pending: Mutex::new(None),
            acknowledged: Condvar::new(),
        });
        if link
            .client
            .claim_control(&link.session, &link.generation, false)
            .map_err(|error| format!("{error:#}"))?
            .is_some_and(|status| status.owned)
        {
            link.client
                .request(Operation::Resize {
                    id: link.session.clone(),
                    generation: link.generation.clone(),
                    rows,
                    cols,
                })
                .map_err(|error| format!("{error:#}"))?;
        }
        {
            let mut state = self.registry.lock().map_err(|e| e.to_string())?;
            if state.closed {
                return Err("Client is closed".into());
            }
            if state.links.len() >= 128 && !state.links.contains_key(&attachment) {
                return Err("Terminal attachment limit reached".into());
            }
            if let Some(previous) = state.links.insert(attachment.clone(), link.clone()) {
                previous.stop();
            }
            state.active += 1;
        }
        let worker = Worker {
            links: self.clone(),
            attachment,
            link: link.clone(),
        };
        std::thread::Builder::new()
            .name("uterm-terminal-stream".into())
            .spawn(move || {
                let _worker = worker;
                if let Err(error) = stream(&link, &_worker.attachment, &sink) {
                    if !link.stopped() {
                        let frame = Frame {
                            input_control: None,
                            agent_events: None,
                            agent_activity_error: None,
                            agent_state: None,
                            foreground_agent: None,
                            sequence: 0,
                            reset: false,
                            rows,
                            cols,
                            data: vec![],
                            exited: false,
                            code: None,
                            error: Some(format!("连接已断开：{error}。请重新连接。")),
                        };
                        if let Err(error) = sink(&_worker.attachment, &link.generation, frame) {
                            eprintln!("Could not report disconnected session: {error}");
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(generation)
    }
    pub fn action(
        &self,
        attachment: &str,
        action: &str,
        data: Option<Vec<u8>>,
        rows: Option<u16>,
        cols: Option<u16>,
        sequence: Option<u64>,
    ) -> Result<(), String> {
        if action == "detach" {
            if let Ok(link) = self.get(attachment) {
                link.stop();
                self.remove(attachment, &link)?;
            }
            return Ok(());
        }
        let link = self.get(attachment)?;
        if action == "ack" {
            let mut pending = link.pending.lock().map_err(|e| e.to_string())?;
            if *pending == sequence {
                *pending = None;
                link.acknowledged.notify_all();
            }
            return Ok(());
        }
        if action == "takeControl" {
            if !link.client.supports_input_control() {
                return Err("SESSION_CONTROL_UNSUPPORTED".into());
            }
            link.client
                .claim_control(&link.session, &link.generation, true)
                .map_err(|error| format!("{error:#}"))?;
            if let (Some(rows), Some(cols)) = (rows, cols) {
                link.client
                    .request(Operation::Resize {
                        id: link.session.clone(),
                        generation: link.generation.clone(),
                        rows,
                        cols,
                    })
                    .map_err(|error| format!("{error:#}"))?;
            }
            return Ok(());
        }
        if action == "releaseControl" {
            return link
                .client
                .release_control(&link.session, &link.generation)
                .map_err(|error| format!("{error:#}"));
        }
        let id = link.session.clone();
        let generation = link.generation.clone();
        let operation = match action {
            "write" => Operation::Write {
                id,
                generation,
                data: data.ok_or("Missing input")?,
            },
            "resize" => Operation::Resize {
                id,
                generation,
                rows: rows.ok_or("Missing rows")?,
                cols: cols.ok_or("Missing columns")?,
            },
            "close" => Operation::Close { id, generation },
            _ => return Err("Unknown session action".into()),
        };
        link.client
            .request(operation)
            .map_err(|e| format!("{e:#}"))?;
        if action == "close" {
            link.stop();
            self.remove(attachment, &link)?;
        }
        Ok(())
    }
}
pub fn encode_frame(frame: &Frame, identity: Option<(&str, &str)>) -> Vec<u8> {
    let metadata = TerminalHeader {
        input_control: frame.input_control.as_ref().map(|status| InputControl {
            owned: status.owned,
            owner: status.owner.clone(),
        }),
        attachment: identity.map(|v| v.0.to_string()),
        generation: identity.map(|v| v.1.to_string()),
        agent_state: frame.agent_state.clone(),
        agent_events: frame.agent_events.as_ref().map(|events| {
            events
                .iter()
                .map(|event| ActivityEvent {
                    id: event.id.clone(),
                    sequence: event.sequence,
                    kind: event.kind.clone(),
                    source: event.source.clone(),
                })
                .collect()
        }),
        agent_activity_error: frame.agent_activity_error.clone(),
        foreground_agent: frame.foreground_agent.clone(),
        sequence: frame.sequence,
        reset: frame.reset,
        rows: frame.rows,
        cols: frame.cols,
        exited: frame.exited,
        code: frame.code,
        error: frame.error.clone(),
    };
    let header = serde_json::to_vec(&metadata).expect("terminal metadata is serializable");
    let mut bytes = Vec::with_capacity(4 + header.len() + frame.data.len());
    bytes.extend_from_slice(&(header.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(&frame.data);
    bytes
}
fn stream(link: &Link, attachment: &str, sink: &Sink) -> Result<(), String> {
    let mut cursor = None;
    let mut input_control = None;
    let mut heartbeat = Instant::now();
    while !link.stopped() {
        let frame = match link
            .client
            .request(Operation::Read {
                id: link.session.clone(),
                generation: link.generation.clone(),
                after: cursor,
            })
            .map_err(|e| format!("{e:#}"))?
        {
            Reply::Frame(frame) => frame,
            _ => return Err("Invalid output response".into()),
        };
        if link.stopped() {
            break;
        }
        // A claim can change the role at an already delivered byte cursor; forward that empty update.
        // 接管可能在已交付的字节游标上改变输入角色，仍需交付该空内容更新。
        if cursor == Some(frame.sequence) && input_control == frame.input_control && !frame.reset {
            continue;
        }
        cursor = Some(frame.sequence);
        input_control = frame.input_control.clone();
        let exited = frame.exited;
        *link.pending.lock().map_err(|e| e.to_string())? = Some(frame.sequence);
        sink(attachment, &link.generation, frame)?;
        // Consume and acknowledge one frame before fetching the next, including hidden views.
        // 消费并确认当前帧后才获取下一帧，隐藏视图也遵循此规则。
        let mut pending = link.pending.lock().map_err(|e| e.to_string())?;
        while pending.is_some() && !link.stopped() {
            pending = link
                .acknowledged
                .wait_timeout(pending, Duration::from_millis(250))
                .map_err(|e| e.to_string())?
                .0;
            if !link.stopped() && heartbeat.elapsed() >= Duration::from_secs(5) {
                drop(pending);
                if link.client.has_input_control() {
                    link.client
                        .claim_control(&link.session, &link.generation, false)
                        .map_err(|error| format!("{error:#}"))?;
                }
                heartbeat = Instant::now();
                pending = link.pending.lock().map_err(|error| error.to_string())?;
            }
        }
        if exited {
            while !link.stopped() {
                pending = link
                    .acknowledged
                    .wait_timeout(pending, Duration::from_secs(1))
                    .map_err(|e| e.to_string())?
                    .0;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acknowledgements_accept_exact_legacy_numbers_and_decimal_u64() {
        for n in [0, (1u64 << 53) - 1, 1u64 << 53, (1u64 << 53) + 1, u64::MAX] {
            assert_eq!(parse_sequence(&serde_json::json!(n)).unwrap(), n);
            assert_eq!(
                parse_sequence(&serde_json::json!(n.to_string())).unwrap(),
                n
            );
        }
        for value in [
            serde_json::json!("18446744073709551616"),
            serde_json::json!("01"),
            serde_json::json!("+1"),
            serde_json::json!("1e2"),
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::Value::Null,
        ] {
            assert!(parse_sequence(&value).is_err(), "{value}");
        }
    }

    #[test]
    fn binary_frame_preserves_metadata_and_raw_output() {
        let frame = Frame {
            input_control: Some(utermd_local::session_control::Status {
                owned: true,
                owner: Some("uTerm 中文 e\u{301}".into()),
            }),
            agent_events: None,
            agent_activity_error: None,
            agent_state: Some("idle".into()),
            foreground_agent: None,
            sequence: 42,
            reset: true,
            rows: 24,
            cols: 80,
            data: (0..=255).collect(),
            exited: true,
            code: Some(1),
            error: Some("连接错误".into()),
        };
        for data in [frame.data.clone(), vec![]] {
            let frame = Frame {
                data,
                ..frame.clone()
            };
            let bytes = encode_frame(&frame, None);
            let length = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
            let metadata: serde_json::Value =
                serde_json::from_slice(&bytes[4..4 + length]).unwrap();
            let mut expected = serde_json::to_value(&frame).unwrap();
            expected.as_object_mut().unwrap().remove("data");
            assert_eq!(metadata, expected);
            assert_eq!(&bytes[4 + length..], frame.data);
        }
    }

    #[test]
    fn shared_u64_fixtures_match_the_actual_binary_encoder() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../shared/fixtures/terminal-precision.json"
        ))
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let sequence: u64 = fixture["sequence"].as_str().unwrap().parse().unwrap();
            let expected: TerminalHeader =
                serde_json::from_str(fixture["header"].as_str().unwrap()).unwrap();
            assert_eq!(expected.sequence, sequence);
            assert_eq!(
                expected.agent_events.as_ref().unwrap()[0].sequence,
                sequence
            );
            let frame = Frame {
                input_control: expected.input_control.as_ref().map(|control| {
                    utermd_local::session_control::Status {
                        owned: control.owned,
                        owner: control.owner.clone(),
                    }
                }),
                sequence,
                agent_events: Some(vec![utermd_local::activity::ActivityEvent {
                    id: "precision".into(),
                    sequence,
                    kind: "notice".into(),
                    source: "terminal".into(),
                }]),
                agent_state: None,
                agent_activity_error: None,
                foreground_agent: None,
                reset: true,
                rows: 24,
                cols: 80,
                data: vec![0, 255],
                exited: false,
                code: None,
                error: None,
            };
            let bytes = encode_frame(&frame, Some(("precision", "generation")));
            let length = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
            let actual: TerminalHeader = serde_json::from_slice(&bytes[4..4 + length]).unwrap();
            assert_eq!(actual.sequence, sequence);
            assert_eq!(actual.agent_events.as_ref().unwrap()[0].sequence, sequence);
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
            assert_eq!(&bytes[4 + length..], &[0, 255]);
        }
    }

    #[test]
    fn stale_close_does_not_remove_a_reconnected_attachment() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        std::fs::write(directory.path().join("endpoint.json"), serde_json::to_vec(
            &serde_json::json!({"version": 1, "port": listener.local_addr().unwrap().port(), "token": "test"})
        ).unwrap()).unwrap();
        // Only simulate the initial handshake; this regression must not launch a real host.
        // 只模拟初始握手，此回归测试不得启动真实宿主。
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut length = [0; 4];
            socket.read_exact(&mut length).unwrap();
            let mut request = vec![0; u32::from_be_bytes(length) as usize];
            socket.read_exact(&mut request).unwrap();
            let reply = serde_json::to_vec(&Reply::Ready {
                pid: 1,
                capabilities: vec![],
            })
            .unwrap();
            socket
                .write_all(&(reply.len() as u32).to_be_bytes())
                .unwrap();
            socket.write_all(&reply).unwrap();
        });
        let client = Client::connect(directory.path()).unwrap();
        server.join().unwrap();
        let make_link = || {
            Arc::new(Link {
                session: "session".into(),
                generation: "generation".into(),
                client: client.clone(),
                stopped: AtomicBool::new(false),
                pending: Mutex::new(None),
                acknowledged: Condvar::new(),
            })
        };
        let old = make_link();
        let current = make_link();
        let state = Links::default();
        state
            .registry
            .lock()
            .unwrap()
            .links
            .insert("attachment".into(), current.clone());
        state.remove("attachment", &old).unwrap();
        assert!(Arc::ptr_eq(&state.get("attachment").unwrap(), &current));
        state.remove("attachment", &current).unwrap();
        assert!(state.get("attachment").is_err());
    }
}
