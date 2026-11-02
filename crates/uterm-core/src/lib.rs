mod connections;
mod control;
pub mod files;
pub mod host;
pub mod session_state;
pub mod state;
pub mod store;
pub mod terminal;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

pub const CONTRACT_VERSION: u32 = 1;
pub const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct CoreError {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}
impl CoreError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recoverable: true,
        }
    }
}
impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for CoreError {}
impl From<std::io::Error> for CoreError {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO", error.to_string())
    }
}
impl From<serde_json::Error> for CoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("INVALID_JSON", error.to_string())
    }
}
pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Response {
    pub version: u32,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CoreError>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub version: u32,
    pub operation_id: String,
    pub kind: String,
    pub revision: String,
}
#[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct ViewSnapshot {
    pub snapshot: store::Snapshot,
    pub sessions: Vec<session_state::Entry>,
    pub layout: Value,
}

pub struct Core {
    store: store::Store,
    host: OnceLock<host::HostBroker>,
    links: Arc<terminal::Links>,
    terminal_sink: Mutex<Option<terminal::Sink>>,
    control: Mutex<Option<Arc<utermd_local::control::Control>>>,
}
impl Core {
    pub fn open(root: PathBuf) -> Result<Self> {
        Ok(Self {
            store: store::Store::open(root)?,
            host: OnceLock::new(),
            links: Arc::new(terminal::Links::default()),
            terminal_sink: Mutex::new(None),
            control: Mutex::new(None),
        })
    }
    pub fn set_terminal_sink(&self, sink: terminal::Sink) -> Result<()> {
        *self
            .terminal_sink
            .lock()
            .map_err(|_| CoreError::new("STATE", "Terminal subscription is unavailable"))? =
            Some(sink);
        Ok(())
    }
    pub fn close(&self) {
        self.links.shutdown();
        if let Ok(mut control) = self.control.lock() {
            control.take();
        }
    }
    fn control(&self) -> Result<Arc<utermd_local::control::Control>> {
        self.control
            .lock()
            .map_err(|_| CoreError::new("CONTROL", "Control state is unavailable"))?
            .clone()
            .ok_or_else(|| CoreError::new("CONTROL", "Start local control before using it"))
    }
    fn data_root(&self) -> Result<&std::path::Path> {
        if self.store.root().file_name().and_then(|v| v.to_str()) != Some("shared-state-v1") {
            return Err(CoreError::new(
                "APP_DATA_CONFIG",
                "Platform services require a named canonical app-data directory",
            ));
        }
        self.store
            .root()
            .parent()
            .ok_or_else(|| CoreError::new("APP_DATA_CONFIG", "App data directory is unavailable"))
    }
    pub fn terminal_write(&self, attachment: &str, bytes: &[u8]) -> Result<()> {
        for chunk in bytes.chunks(16 * 1024) {
            self.links
                .action(attachment, "write", Some(chunk.to_vec()), None, None, None)
                .map_err(host_error)?;
        }
        Ok(())
    }
    fn host_client(&self) -> Result<utermd_local::daemon::Client> {
        self.host
            .get()
            .ok_or_else(|| {
                CoreError::new(
                    "HOST_CONFIG",
                    "Configure the bundled Rust helper before opening a host",
                )
            })?
            .client()
            .map_err(host_error)
    }
    pub fn execute(&self, bytes: &[u8]) -> Response {
        let mut id = String::new();
        let outcome = (|| {
            if bytes.len() > MAX_REQUEST_BYTES {
                return Err(CoreError::new(
                    "REQUEST_TOO_LARGE",
                    "Request exceeds the bounded control limit",
                ));
            }
            let request: Request = serde_json::from_slice(bytes)?;
            id.clone_from(&request.id);
            if request.version != CONTRACT_VERSION {
                return Err(CoreError::new(
                    "UNSUPPORTED_VERSION",
                    "Unsupported control contract version",
                ));
            }
            if id.is_empty() || id.len() > 128 {
                return Err(CoreError::new("INVALID_OPERATION", "Invalid operation ID"));
            }
            self.dispatch(&request.method, request.params)
        })();
        match outcome {
            Ok(value) => Response {
                version: CONTRACT_VERSION,
                id,
                result: Some(value),
                error: None,
            },
            Err(error) => Response {
                version: CONTRACT_VERSION,
                id,
                result: None,
                error: Some(error),
            },
        }
    }
    fn dispatch(&self, method: &str, params: Value) -> Result<Value> {
        match method {
            "control.start" => {
                let mut state = self
                    .control
                    .lock()
                    .map_err(|_| CoreError::new("CONTROL", "Control state is unavailable"))?;
                if state.is_none() {
                    *state = Some(
                        utermd_local::control::Control::start(self.data_root()?)
                            .map_err(|e| CoreError::new("CONTROL", e))?,
                    );
                }
                Ok(state.as_ref().unwrap().status())
            }
            "control.status" => Ok(self.control()?.status()),
            "control.configure" => {
                let enabled = params["enabled"]
                    .as_bool()
                    .ok_or_else(|| CoreError::new("INVALID_PARAMS", "enabled must be boolean"))?;
                let control = self.control()?;
                control
                    .configure(enabled)
                    .map_err(|e| CoreError::new("CONTROL", e))?;
                Ok(control.status())
            }
            "control.poll" => serde_json::to_value(
                self.control()?
                    .poll()
                    .map_err(|e| CoreError::new("CONTROL", e))?,
            )
            .map_err(Into::into),
            "control.execute" => {
                let request = self
                    .control()?
                    .execution_request(&string(&params, "requestId")?)
                    .map_err(|e| CoreError::new("CONTROL", e))?;
                control::execute(self, request, &params)
            }
            "control.reply" => {
                self.control()?
                    .reply(&string(&params, "id")?, params["result"].clone())
                    .map_err(|e| CoreError::new("CONTROL", e))?;
                Ok(Value::Null)
            }
            "control.openLink" => {
                self.control()?
                    .open_link(&string(&params, "url")?)
                    .map_err(|e| CoreError::new("CONTROL", e))?;
                Ok(Value::Null)
            }
            method if method.starts_with("files.") => files::request(method, params),
            "directory.resolve" => Ok(json!(host::project_directory(string(
                &params,
                "directory"
            )?)
            .map_err(host_error)?)),
            "host.environment" => {
                let data = self.data_root()?;
                let chats = data.join("chats");
                std::fs::create_dir_all(&chats)?;
                let definitions =
                    utermd_local::agents::read(data).map_err(|e| host_error(e.to_string()))?;
                let mut agents: Vec<String> = utermd_local::agents::BUILTIN_AGENTS
                    .iter()
                    .map(|s| s.to_string())
                    .chain(definitions.iter().map(|a| a.id.clone()))
                    .collect();
                agents.sort();
                agents.dedup();
                agents.retain(|id| utermd_local::agents::resolve(data, id).is_ok());
                Ok(
                    json!({"agents":agents,"home":std::env::var(if cfg!(windows){"USERPROFILE"}else{"HOME"}).unwrap_or_default(),"chatDirectory":chats,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH}),
                )
            }
            "host.configure" => {
                if self.store.root().file_name().and_then(|v| v.to_str()) != Some("shared-state-v1")
                {
                    return Err(CoreError::new(
                        "HOST_CONFIG",
                        "Host access requires a named canonical app-data directory",
                    ));
                }
                let helper = PathBuf::from(string(&params, "helper")?);
                if !helper.is_absolute() || !helper.is_file() {
                    return Err(CoreError::new(
                        "HOST_CONFIG",
                        "Bundled helper must be an existing absolute executable path",
                    ));
                }
                let broker = host::HostBroker::new(
                    self.store.root().parent().unwrap().join("local-daemon-v1"),
                    helper,
                );
                self.host
                    .set(broker)
                    .map_err(|_| CoreError::new("HOST_CONFIG", "Host is already configured"))?;
                Ok(json!({"configured":true}))
            }
            "host.status" => {
                match self
                    .host_client()?
                    .request(utermd_local::daemon::Operation::HostStatus)
                    .map_err(|e| host_error(e.to_string()))?
                {
                    utermd_local::daemon::Reply::HostStatus(status) => {
                        serde_json::to_value(status).map_err(Into::into)
                    }
                    _ => Err(CoreError::new("HOST_REPLY", "Invalid host status")),
                }
            }
            "host.shutdownIdle" => {
                match self
                    .host_client()?
                    .request(utermd_local::daemon::Operation::ShutdownIfIdle)
                    .map_err(|e| host_error(e.to_string()))?
                {
                    utermd_local::daemon::Reply::Done => Ok(Value::Null),
                    _ => Err(CoreError::new(
                        "HOST_REPLY",
                        "Host did not confirm idle shutdown",
                    )),
                }
            }
            "host.close" => {
                use utermd_local::daemon::{Operation, Reply};
                let id = string(&params, "id")?;
                if !self
                    .data_root()?
                    .join("local-daemon-v1/endpoint.json")
                    .exists()
                {
                    return Ok(Value::Null);
                }
                let client = self.host_client()?;
                let Reply::HostStatus(status) = client
                    .request(Operation::HostStatus)
                    .map_err(|e| host_error(e.to_string()))?
                else {
                    return Err(CoreError::new("HOST_REPLY", "Invalid host status"));
                };
                if let Some(session) = status.sessions.into_iter().find(|s| s.spec.id == id) {
                    if params["generation"].as_str() != Some(session.generation.as_str()) {
                        return Err(CoreError::new(
                            "STALE_GENERATION",
                            "Reconnect before closing a different hosted generation",
                        ));
                    }
                    match client
                        .request(Operation::Close {
                            id: id.clone(),
                            generation: session.generation,
                        })
                        .map_err(|e| host_error(e.to_string()))?
                    {
                        Reply::Done => {}
                        _ => {
                            return Err(CoreError::new(
                                "HOST_REPLY",
                                "Host did not confirm session close",
                            ))
                        }
                    }
                }
                self.links.stop_session(&id);
                Ok(Value::Null)
            }
            "terminal.open" => {
                if params.get("ssh").is_some() {
                    return Err(CoreError::new(
                        "UNSUPPORTED",
                        "Remote terminals require SSH service adoption",
                    ));
                }
                use utermd_local::daemon::{Operation, SessionSpec};
                let attachment = string(&params, "attachment")?;
                let id = string(&params, "id")?;
                if [attachment.as_str(), id.as_str()]
                    .iter()
                    .any(|id| id.is_empty() || id.len() > 128)
                {
                    return Err(CoreError::new(
                        "INVALID_ARGUMENT",
                        "Invalid session or attachment ID",
                    ));
                }
                let directory = PathBuf::from(string(&params, "directory")?);
                let shell = string(&params, "shell")?;
                let rows = dimension(&params, "rows")?;
                let cols = dimension(&params, "cols")?;
                let client = self.host_client()?;
                let agent = params
                    .get("agent")
                    .and_then(Value::as_str)
                    .map(String::from);
                if agent.is_some() {
                    client
                        .require_agent_support()
                        .map_err(|e| host_error(e.to_string()))?;
                }
                let spec = SessionSpec {
                    id: id.clone(),
                    directory,
                    shell,
                    agent,
                    ssh: None,
                };
                if params["reconnectOnly"] == true {
                    match client
                        .request(Operation::HostStatus)
                        .map_err(|e| host_error(e.to_string()))?
                    {
                        utermd_local::daemon::Reply::HostStatus(status)
                            if status.sessions.iter().any(|s| s.spec.id == id) => {}
                        _ => {
                            return Err(CoreError::new(
                                "SESSION_MISSING",
                                "Session is no longer hosted",
                            ))
                        }
                    }
                }
                let operation = if params["taskOnly"] == true {
                    Operation::Attach {
                        id: id.clone(),
                        rows,
                        cols,
                    }
                } else {
                    Operation::Open { spec, rows, cols }
                };
                let sink = self
                    .terminal_sink
                    .lock()
                    .map_err(|_| CoreError::new("STATE", "Terminal subscription is unavailable"))?
                    .clone()
                    .ok_or_else(|| {
                        CoreError::new(
                            "NO_SUBSCRIBER",
                            "Subscribe to binary frames before opening a terminal",
                        )
                    })?;
                let generation = self
                    .links
                    .open(client, operation, id, attachment, rows, cols, sink)
                    .map_err(host_error)?;
                Ok(json!({"generation":generation}))
            }
            "terminal.action" => {
                let attachment = string(&params, "attachment")?;
                let action = string(&params, "action")?;
                if action == "write" {
                    return Err(CoreError::new(
                        "BINARY_REQUIRED",
                        "Terminal input must use the byte channel",
                    ));
                }
                let rows = params
                    .get("rows")
                    .map(|_| dimension(&params, "rows"))
                    .transpose()?;
                let cols = params
                    .get("cols")
                    .map(|_| dimension(&params, "cols"))
                    .transpose()?;
                let sequence = params
                    .get("sequence")
                    .map(terminal::parse_sequence)
                    .transpose()
                    .map_err(host_error)?;
                if action == "ack" && sequence.is_none() {
                    return Err(CoreError::new(
                        "INVALID_ARGUMENT",
                        "Acknowledgement requires a sequence",
                    ));
                }
                self.links
                    .action(&attachment, &action, None, rows, cols, sequence)
                    .map_err(host_error)?;
                Ok(Value::Null)
            }
            "contract.info" => Ok(
                json!({"version":CONTRACT_VERSION,"storageSchema":1,"terminalEncoding":"binary","maximumRequestBytes":MAX_REQUEST_BYTES}),
            ),
            "state.defaults" => Ok(state::defaults()),
            "snapshot.read" => serde_json::to_value(self.store.read()?).map_err(Into::into),
            "snapshot.view" => {
                let snapshot = self.store.read()?;
                let sessions = session_state::entries(&snapshot.document.workspace);
                let layout = session_state::layout(&snapshot.document.workspace);
                serde_json::to_value(ViewSnapshot {
                    snapshot,
                    sessions,
                    layout,
                })
                .map_err(Into::into)
            }
            "session.entries" => serde_json::to_value(session_state::entries(
                &self.store.read()?.document.workspace,
            ))
            .map_err(Into::into),
            method if method.starts_with("session.") => {
                let revision = string(&params, "expectedRevision")?;
                let mut params = params;
                let method = if method == "session.createChat" {
                    let settings = self.store.read()?.document.settings;
                    let data = self.data_root()?;
                    let enabled = settings["enabledAgents"].as_array().unwrap();
                    let agent = std::iter::once(&settings["defaultAgent"])
                        .chain(enabled.iter())
                        .find(|id| {
                            enabled.contains(id)
                                && id.as_str().is_some_and(|id| {
                                    utermd_local::agents::resolve(data, id).is_ok()
                                })
                        })
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            CoreError::new(
                                "AGENT_UNAVAILABLE",
                                "Enable an installed Agent before creating a chat",
                            )
                        })?
                        .to_string();
                    params["agent"] = json!(agent);
                    params["projectId"] = Value::Null;
                    if params.get("name").is_none() {
                        params["name"] = json!(agent);
                    }
                    "session.create"
                } else {
                    method
                };
                let project = params
                    .get("projectId")
                    .unwrap_or(&self.store.read()?.document.workspace["selectedProject"])
                    .clone();
                if method == "session.create"
                    && params.get("directory").is_none()
                    && project.is_null()
                {
                    let directory = if params.get("agent").is_some_and(|v| !v.is_null()) {
                        let chats = self.data_root()?.join("chats");
                        std::fs::create_dir_all(&chats)?;
                        chats.into_os_string().into_string().map_err(|_| {
                            CoreError::new("INVALID_PATH", "Chat directory is not UTF-8")
                        })?
                    } else {
                        std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map_err(
                            |_| CoreError::new("INVALID_PATH", "Home directory is unavailable"),
                        )?
                    };
                    params["directory"] = json!(directory);
                }
                self.store
                    .update(&revision, |d| {
                        session_state::transition(&mut d.workspace, &d.settings, method, &params)
                    })
                    .and_then(|s| serde_json::to_value(s).map_err(Into::into))
            }
            "settings.agent.toggle" => {
                let revision = string(&params, "expectedRevision")?;
                let agent = string(&params, "agent")?;
                let enabled = params["enabled"].as_bool().ok_or_else(|| {
                    CoreError::new("INVALID_ARGUMENT", "Agent enablement must be boolean")
                })?;
                self.store
                    .update(&revision, |d| {
                        let agents = d.settings["enabledAgents"].as_array_mut().unwrap();
                        if enabled {
                            if !agents.contains(&json!(agent)) {
                                agents.push(json!(agent));
                            }
                        } else {
                            agents.retain(|v| v != &agent);
                        }
                        state::validate_settings(&d.settings)
                    })
                    .and_then(|s| serde_json::to_value(s).map_err(Into::into))
            }
            "settings.font.adjust" => {
                let revision = string(&params, "expectedRevision")?;
                let key = string(&params, "key")?;
                if !["fontSize", "fileFontSize", "gitDiffFontSize"].contains(&key.as_str()) {
                    return Err(CoreError::new("INVALID_ARGUMENT", "Unknown font setting"));
                }
                let delta = params["delta"]
                    .as_f64()
                    .filter(|d| d.is_finite() && d.abs() <= 1.0)
                    .ok_or_else(|| {
                        CoreError::new(
                            "INVALID_ARGUMENT",
                            "Font adjustment must be at most one point",
                        )
                    })?;
                self.store
                    .update(&revision, |d| {
                        d.settings[&key] =
                            json!((d.settings[&key].as_f64().unwrap() + delta).clamp(10.0, 32.0));
                        state::validate_settings(&d.settings)
                    })
                    .and_then(|s| serde_json::to_value(s).map_err(Into::into))
            }
            "recovery.list" => self.store.recovery_list(),
            "recovery.restore" => serde_json::to_value(self.store.recover(
                &string(&params, "expectedRevision")?,
                &string(&params, "backupRevision")?,
            )?)
            .map_err(Into::into),
            "migration.import" => {
                let input: store::Import = serde_json::from_value(params)?;
                serde_json::to_value(self.store.import(input)?).map_err(Into::into)
            }
            "legacy.export" => {
                let snapshot = self.store.read()?;
                let mut legacy = snapshot.document.legacy;
                legacy.insert(
                    "uterm.desktop.workspace.v1".into(),
                    serde_json::to_string(&snapshot.document.workspace)?,
                );
                legacy.insert(
                    "uterm.desktop.settings.v1".into(),
                    serde_json::to_string(&snapshot.document.settings)?,
                );
                Ok(json!({"revision":snapshot.revision,"values":legacy}))
            }
            "snapshot.replace" => {
                let revision = string(&params, "expectedRevision")?;
                self.store
                    .update(&revision, |document| {
                        let workspace = params
                            .get("workspace")
                            .ok_or_else(|| {
                                CoreError::new("INVALID_WORKSPACE", "Workspace is required")
                            })?
                            .clone();
                        let settings = params
                            .get("settings")
                            .ok_or_else(|| {
                                CoreError::new("INVALID_SETTINGS", "Settings are required")
                            })?
                            .clone();
                        state::validate_workspace(&workspace)?;
                        state::validate_settings(&settings)?;
                        document.workspace = workspace;
                        document.settings = settings;
                        Ok(())
                    })
                    .and_then(|snapshot| serde_json::to_value(snapshot).map_err(Into::into))
            }
            method
                if method.starts_with("workspace.")
                    || method.starts_with("project.")
                    || method == "selection.set" =>
            {
                let revision = string(&params, "expectedRevision")?;
                self.store
                    .update(&revision, |document| {
                        state::transition(&mut document.workspace, method, &params)
                    })
                    .and_then(|snapshot| serde_json::to_value(snapshot).map_err(Into::into))
            }
            "settings.patch" => {
                let revision = string(&params, "expectedRevision")?;
                self.store
                    .update(&revision, |document| {
                        let patch =
                            params
                                .get("patch")
                                .and_then(Value::as_object)
                                .ok_or_else(|| {
                                    CoreError::new(
                                        "INVALID_SETTINGS",
                                        "Settings patch must be an object",
                                    )
                                })?;
                        let settings = document.settings.as_object_mut().ok_or_else(|| {
                            CoreError::new("CORRUPT_STORE", "Saved settings are not an object")
                        })?;
                        for (key, value) in patch {
                            settings.insert(key.clone(), value.clone());
                        }
                        state::validate_settings(&document.settings)
                    })
                    .and_then(|snapshot| serde_json::to_value(snapshot).map_err(Into::into))
            }
            _ => Err(CoreError::new(
                "UNKNOWN_METHOD",
                format!("Unknown operation: {method}"),
            )),
        }
    }
}
pub(crate) fn string(value: &Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| CoreError::new("INVALID_ARGUMENT", format!("Missing string: {key}")))
}
fn host_error(message: String) -> CoreError {
    CoreError::new("HOST", message)
}
fn dimension(value: &Value, key: &str) -> Result<u16> {
    value[key]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 1000)
        .map(|n| n as u16)
        .ok_or_else(|| {
            CoreError::new(
                "INVALID_ARGUMENT",
                "Terminal dimensions must be between 1 and 1000",
            )
        })
}
impl Drop for Core {
    fn drop(&mut self) {
        self.close();
    }
}
