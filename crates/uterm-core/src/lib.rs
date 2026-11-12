pub mod agent_install;
pub mod agents;
pub mod archives;
mod configuration;
mod connections;
mod control;
pub mod credentials;
pub mod database;
pub mod database_components;
pub mod downloads;
pub mod files;
pub mod git;
pub mod github;
pub mod host;
pub mod java;
pub mod java_components;
pub mod project_runs;
pub mod python;
pub mod redis;
pub mod session_state;
pub mod settings;
pub mod ssh;
pub mod state;
pub mod store;
pub mod terminal;
pub mod worktrees;

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
    ssh: Mutex<Option<Arc<ssh::service::Service>>>,
    database: Mutex<Option<Arc<database::service::Service>>>,
    redis: Mutex<Option<Arc<redis::service::Service>>>,
    agent: Mutex<Option<agents::Host>>,
    java_components: Mutex<Option<Arc<java_components::service::Service>>>,
}
impl Core {
    pub fn open(root: PathBuf) -> Result<Self> {
        Ok(Self {
            store: store::Store::open(root)?,
            host: OnceLock::new(),
            links: Arc::new(terminal::Links::default()),
            terminal_sink: Mutex::new(None),
            control: Mutex::new(None),
            ssh: Mutex::new(None),
            database: Mutex::new(None),
            redis: Mutex::new(None),
            agent: Mutex::new(None),
            java_components: Mutex::new(None),
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
        if let Ok(service) = self.java_components.lock() {
            if let Some(service) = service.as_ref() {
                service.close();
            }
        }
        if let Ok(mut redis) = self.redis.lock() {
            if let Some(service) = redis.take() {
                service.close();
            }
        }
        if let Ok(mut database) = self.database.lock() {
            if let Some(service) = database.take() {
                service.close();
            }
        }
        if let Ok(mut ssh) = self.ssh.lock() {
            if let Some(service) = ssh.take() {
                service.close();
            }
        }
        self.links.shutdown();
        if let Ok(mut control) = self.control.lock() {
            control.take();
        }
    }
    pub fn java_components(&self) -> Result<Arc<java_components::service::Service>> {
        let mut service = self.java_components.lock().map_err(|_| {
            CoreError::new("JAVA_OPERATION_FAILED", "Java components are unavailable")
        })?;
        if service.is_none() {
            *service = Some(Arc::new(java_components::service::Service::new(
                java_components::Host::new(self.data_root()?.to_path_buf()),
            )));
        }
        Ok(service.as_ref().unwrap().clone())
    }
    fn java_request(&self, method: &str, params: &Value) -> Result<Value> {
        if method.starts_with("java.components.") {
            let service = self.java_components()?;
            return match method {
                "java.components.status" => Ok(
                    json!({"catalog":java_result(service.status())?,"operation":java_result(service.active())?,"progress":java_result(service.progress())?}),
                ),
                "java.components.start" => {
                    let path = match params.get("path") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(path)) => Some(PathBuf::from(path)),
                        _ => {
                            return Err(CoreError::new(
                                "INVALID_PARAMS",
                                "path must be text or null",
                            ))
                        }
                    };
                    service_json(java_result(service.start(
                        string(params, "action")?,
                        string(params, "component")?,
                        path,
                    ))?)
                }
                "java.components.read" => service_json(java_result(service.read(
                    &string(params, "id")?,
                    &string(params, "generation")?,
                    params["consume"].as_bool().ok_or_else(|| {
                        CoreError::new("INVALID_PARAMS", "consume must be boolean")
                    })?,
                ))?),
                "java.components.cancel" => service_json(java_result(
                    service.cancel(&string(params, "id")?, &string(params, "generation")?),
                )?),
                _ => Err(CoreError::new(
                    "METHOD_NOT_FOUND",
                    "Unknown Java component method",
                )),
            };
        }
        let directory = match params.get("directory") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.as_str()),
            _ => {
                return Err(CoreError::new(
                    "INVALID_PARAMS",
                    "directory must be text or null",
                ))
            }
        };
        match method {
            "java.configuration" => service_json(java_result(java::configuration(
                self.data_root()?,
                directory,
                true,
            ))?),
            "java.saveConfiguration" => {
                let global = if params["global"].is_null() {
                    None
                } else {
                    Some(serde_json::from_value(params["global"].clone())?)
                };
                let project = if params["project"].is_null() {
                    None
                } else {
                    Some(serde_json::from_value(params["project"].clone())?)
                };
                service_json(java_result(java::save_configuration(
                    self.data_root()?,
                    directory,
                    &string(params, "revision")?,
                    global,
                    project,
                ))?)
            }
            "java.project" => service_json(java_result(java::project_info(&string(
                params,
                "directory",
            )?))?),
            "java.jdks.list" => service_json(java_result(java::find_jdks(self.data_root()?))?),
            "java.jdks.register" => {
                java_result(java::register_jdk(
                    self.data_root()?,
                    &string(params, "home")?,
                    params["remove"].as_bool().ok_or_else(|| {
                        CoreError::new("INVALID_PARAMS", "remove must be a boolean")
                    })?,
                ))?;
                service_json(java_result(java::find_jdks(self.data_root()?))?)
            }
            "project.tasks" => service_json(project_runs::running(java_result(
                project_runs::read(&self.data_root()?.join("local-daemon-v1")),
            )?)),
            "java.tasks" => service_json(java_result(java::tasks(
                &self.data_root()?.join("local-daemon-v1"),
                &string(params, "directory")?,
            ))?),
            "java.start" => {
                let config = serde_json::from_value(params["config"].clone())?;
                let environment = serde_json::from_value(params["environment"].clone())?;
                let prepared = java_result(java::build_launch(
                    self.data_root()?,
                    &string(params, "directory")?,
                    &config,
                    &string(params, "action")?,
                    environment,
                ))?;
                service_json(java_result(java::start(&self.host_client()?, prepared))?)
            }
            "java.stop" => {
                java_result(java::stop(
                    &self.host_client()?,
                    string(params, "id")?,
                    string(params, "generation")?,
                    params["force"].as_bool().ok_or_else(|| {
                        CoreError::new("INVALID_PARAMS", "force must be a boolean")
                    })?,
                ))?;
                Ok(Value::Null)
            }
            _ => Err(CoreError::new("METHOD_NOT_FOUND", "Unknown Java method")),
        }
    }
    fn python_request(&self, method: &str, params: &Value) -> Result<Value> {
        let directory = || string(params, "directory");
        let root = || python_result(python::root(&directory()?));
        match method {
            "python.configuration" => service_json(python_result(python::configuration(
                &python::config_path(self.data_root()?),
                &root()?,
            ))?),
            "python.saveConfiguration" => service_json(python_result(python::save_configuration(
                &python::config_path(self.data_root()?),
                &root()?,
                &string(params, "revision")?,
                serde_json::from_value(params["config"].clone())?,
            ))?),
            "python.interpreters" => {
                service_json(python::interpreters(&root()?, &string(params, "selected")?))
            }
            "python.project" => service_json(python_result(python::project_info(&root()?))?),
            "python.path.validate" => service_json(python_result(python::selected_path(
                &root()?,
                std::path::Path::new(&string(params, "path")?),
                &string(params, "kind")?,
            ))?),
            "python.tasks" => service_json(python_result(python::tasks(
                &self.data_root()?.join("local-daemon-v1"),
                &directory()?,
            ))?),
            "python.start" => {
                let config = serde_json::from_value(params["config"].clone())?;
                let environment = serde_json::from_value(params["environment"].clone())?;
                let prepared = python_result(python::prepare(&directory()?, &config, environment))?;
                service_json(python_result(python::start(
                    &self.host_client()?,
                    prepared,
                ))?)
            }
            "python.stop" => {
                python_result(python::stop(
                    &self.host_client()?,
                    string(params, "id")?,
                    string(params, "generation")?,
                    params["force"].as_bool().ok_or_else(|| {
                        CoreError::new("INVALID_PARAMS", "force must be a boolean")
                    })?,
                ))?;
                Ok(Value::Null)
            }
            _ => Err(CoreError::new("METHOD_NOT_FOUND", "Unknown Python method")),
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
            "settings.catalog" => {
                if !params.is_null() && params.as_object().is_none_or(|p| !p.is_empty()) {
                    return Err(CoreError::new(
                        "SETTINGS_INVALID_PARAMS",
                        "Settings catalog accepts no parameters",
                    ));
                }
                settings::catalog()
            }
            "settings.validate" | "settings.commands" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Validation {
                    settings: Value,
                    platform: settings::Platform,
                }
                let validation: Validation = serde_json::from_value(params).map_err(|_| {
                    CoreError::new(
                        "SETTINGS_INVALID_PARAMS",
                        "Settings and a supported platform are required",
                    )
                })?;
                if method == "settings.commands" {
                    settings::commands(&validation.settings, validation.platform)
                } else {
                    settings::validate(&validation.settings, validation.platform)?;
                    Ok(json!({"valid": true}))
                }
            }
            "settings.theme.import" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct ThemeImport {
                    source: String,
                    name: String,
                }
                let request: ThemeImport = serde_json::from_value(params).map_err(|_| {
                    CoreError::new("THEME_INVALID", "Theme name and source are required")
                })?;
                settings::import_theme(&request.source, &request.name)
            }
            "agent.configure" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Configuration {
                    home: PathBuf,
                }
                let configuration: Configuration =
                    serde_json::from_value(params).map_err(|_| {
                        CoreError::new(
                            "AGENT_INVALID_PARAMS",
                            "Agent home must be an absolute platform directory",
                        )
                    })?;
                if !configuration.home.is_absolute() {
                    return Err(CoreError::new(
                        "AGENT_INVALID_PARAMS",
                        "Agent home must be an absolute platform directory",
                    ));
                }
                let broker = self.host.get().ok_or_else(|| {
                    CoreError::new("HOST_CONFIG", "Configure the bundled reporter first")
                })?;
                let mut current = self.agent.lock().map_err(|_| {
                    CoreError::new(
                        "AGENT_CONFIGURATION",
                        "Agent platform configuration is unavailable",
                    )
                })?;
                if current.is_some() {
                    return Err(CoreError::new(
                        "AGENT_ALREADY_CONFIGURED",
                        "Agent platform directories are already configured",
                    ));
                }
                // Explicit platform roots let QA avoid changing HOME or provider credential selectors.
                // 显式平台目录使 QA 无需修改 HOME 或提供方凭据选择变量。
                *current = Some(agents::Host {
                    data: self.data_root()?.to_path_buf(),
                    home: configuration.home,
                    reporter: broker.helper_source().to_path_buf(),
                    agent_homes: Default::default(),
                });
                Ok(json!({"configured":true}))
            }
            method if method.starts_with("agent.") => {
                let broker = self.host.get().ok_or_else(|| {
                    CoreError::new("HOST_CONFIG", "Configure the bundled reporter first")
                })?;
                let configured = self
                    .agent
                    .lock()
                    .map_err(|_| {
                        CoreError::new(
                            "AGENT_CONFIGURATION",
                            "Agent platform configuration is unavailable",
                        )
                    })?
                    .clone();
                let host = match configured {
                    Some(host) => host,
                    None => agents::Host::from_environment(
                        self.data_root()?.to_path_buf(),
                        broker.helper_source().to_path_buf(),
                    )
                    .map_err(|error| CoreError::new("AGENT_CONFIGURATION", error))?,
                };
                agents::request(host, method, params).map_err(|error| {
                    if error.starts_with("AGENT_")
                        && error
                            .bytes()
                            .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
                    {
                        CoreError::new(&error, &error)
                    } else {
                        CoreError::new("AGENT_OPERATION_FAILED", error)
                    }
                })
            }
            "ssh.info" => {
                if !params.is_null() && params.as_object().is_none_or(|value| !value.is_empty()) {
                    return Err(CoreError::new(
                        "INVALID_PARAMS",
                        "SSH info accepts no parameters",
                    ));
                }
                service_json(ssh::info())
            }
            "ssh.resolve" => {
                let request: ssh::ResolveRequest = serde_json::from_value(params)?;
                let resolved = ssh::resolve(request.connection).map_err(|error| {
                    let message = error.to_string();
                    let prefix = message.split(':').next().unwrap_or_default();
                    let code = if prefix.starts_with("SSH_")
                        && prefix
                            .bytes()
                            .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
                    {
                        prefix
                    } else {
                        "SSH_CONFIG_FAILED"
                    };
                    CoreError::new(code, &message)
                })?;
                service_json(resolved)
            }
            method if method.starts_with("ssh.") => self.ssh_request(method, params),
            method if method.starts_with("database.") => self.database_request(method, params),
            method if method.starts_with("redis.") => self.redis_request(method, params),
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
            method if method.starts_with("github.") => github::request(method, params),
            method if method.starts_with("git.favorites.recovery.") => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Preview {
                    revision: String,
                }
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Restore {
                    revision: String,
                    expected_revision: Option<String>,
                    expected_missing: bool,
                }
                let invalid = |error: serde_json::Error| {
                    CoreError::new("INVALID_ARGUMENT", error.to_string())
                };
                match method {
                    "git.favorites.recovery.list" => {
                        if !params.is_null()
                            && !params.as_object().is_some_and(|object| object.is_empty())
                        {
                            return Err(CoreError::new(
                                "INVALID_ARGUMENT",
                                "Git favorite recovery listing takes no arguments",
                            ));
                        }
                        serde_json::to_value(self.store.favorites_recovery_catalog()?)
                            .map_err(Into::into)
                    }
                    "git.favorites.recovery.preview" | "git.favorites.recovery.source" => {
                        let args: Preview = serde_json::from_value(params).map_err(invalid)?;
                        if method == "git.favorites.recovery.preview" {
                            serde_json::to_value(
                                self.store.favorites_recovery_preview(&args.revision)?,
                            )
                            .map_err(Into::into)
                        } else {
                            Ok(Value::String(
                                self.store.favorites_recovery_source(&args.revision)?,
                            ))
                        }
                    }
                    "git.favorites.recovery.restore" => {
                        let args: Restore = serde_json::from_value(params).map_err(invalid)?;
                        serde_json::to_value(self.store.favorites_recovery_restore(
                            &args.revision,
                            args.expected_revision.as_deref(),
                            args.expected_missing,
                        )?)
                        .map_err(Into::into)
                    }
                    _ => Err(CoreError::new(
                        "UNKNOWN_METHOD",
                        "Unknown Git favorite recovery operation",
                    )),
                }
            }
            method if method.starts_with("git.favorites.") => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Read {
                    directory: String,
                }
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Import {
                    directory: String,
                    legacy: Option<String>,
                }
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Write {
                    directory: String,
                    expected_revision: Option<String>,
                    references: Vec<String>,
                }
                let invalid = |error: serde_json::Error| {
                    CoreError::new("INVALID_ARGUMENT", error.to_string())
                };
                let repository = |directory: &str| {
                    git::favorite_repository(directory)
                        .map_err(|error| CoreError::new("GIT_ERROR", error))
                };
                let result = match method {
                    "git.favorites.read" => {
                        let args: Read = serde_json::from_value(params).map_err(invalid)?;
                        self.store.favorites_read(&repository(&args.directory)?.0)?
                    }
                    "git.favorites.import" | "git.favorites.acceptShared" => {
                        let args: Import = serde_json::from_value(params).map_err(invalid)?;
                        let (repository, alias) = repository(&args.directory)?;
                        if method == "git.favorites.import" {
                            self.store.favorites_import(
                                &repository,
                                &alias,
                                args.legacy.as_deref(),
                            )?
                        } else {
                            self.store.favorites_accept_shared(
                                &repository,
                                &alias,
                                args.legacy.as_deref().ok_or_else(|| {
                                    CoreError::new(
                                        "INVALID_ARGUMENT",
                                        "Missing old Git favorite source",
                                    )
                                })?,
                            )?
                        }
                    }
                    "git.favorites.write" => {
                        let args: Write = serde_json::from_value(params).map_err(invalid)?;
                        let (repository, alias) = repository(&args.directory)?;
                        self.store.favorites_write(
                            &repository,
                            &alias,
                            args.expected_revision.as_deref(),
                            args.references,
                        )?
                    }
                    _ => {
                        return Err(CoreError::new(
                            "UNKNOWN_METHOD",
                            "Unknown Git favorite operation",
                        ))
                    }
                };
                serde_json::to_value(result).map_err(Into::into)
            }
            method if method.starts_with("git.") => git::request(method, params),
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
            method if method.starts_with("java.") => self.java_request(method, &params),
            method if method.starts_with("python.") => self.python_request(method, &params),
            "terminal.open" => {
                let ssh: Option<utermd_local::ssh::SshTarget> = params
                    .get("ssh")
                    .filter(|v| !v.is_null())
                    .map(|v| serde_json::from_value(v.clone()))
                    .transpose()?;
                if let Some(target) = &ssh {
                    target
                        .validate()
                        .map_err(|e| CoreError::new("SSH_INVALID_CONNECTION", e.to_string()))?;
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
                    ssh,
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
                } else if spec.ssh.is_some() {
                    client
                        .require_ssh_support()
                        .map_err(|e| host_error(e.to_string()))?;
                    if spec.ssh.as_ref().is_some_and(|v| v.mode.is_some()) {
                        client
                            .require_ssh_config_support()
                            .map_err(|e| host_error(e.to_string()))?;
                    }
                    if spec.ssh.as_ref().is_some_and(|v| v.jump_host.is_some()) {
                        client
                            .require_ssh_jump_support()
                            .map_err(|e| host_error(e.to_string()))?;
                    }
                    Operation::OpenSsh {
                        spec,
                        rows,
                        cols,
                        create: false,
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
            "editor.drafts.read" => {
                serde_json::to_value(self.store.editor_read()?).map_err(Into::into)
            }
            "editor.drafts.list" => {
                let directory = match params.get("directory") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(value)) => Some(value.as_str()),
                    _ => {
                        return Err(CoreError::new(
                            "INVALID_PARAMS",
                            "Draft directory must be text or null",
                        ))
                    }
                };
                serde_json::to_value(self.store.editor_list(directory)?).map_err(Into::into)
            }
            "pdf.marks.read" | "pdf.marks.write" => self.store.pdf_marks_request(method, params),
            "editor.drafts.document" => serde_json::to_value(
                self.store
                    .editor_document(&string(&params, "directory")?, &string(&params, "path")?)?,
            )
            .map_err(Into::into),
            "editor.drafts.putDocument" => {
                let revision = draft_revision(&params)?;
                serde_json::to_value(self.store.editor_put_document(
                    revision,
                    serde_json::from_value(params["draft"].clone())?,
                )?)
                .map_err(Into::into)
            }
            "editor.drafts.removeDocument" => {
                self.store.editor_remove_document(
                    draft_revision(&params)?,
                    &string(&params, "directory")?,
                    &string(&params, "path")?,
                )?;
                Ok(Value::Null)
            }
            "editor.drafts.import" => {
                let source = match params.get("legacy") {
                    Some(Value::Null) => None,
                    Some(Value::String(value)) => Some(value.clone()),
                    Some(_) => {
                        return Err(CoreError::new(
                            "INVALID_PARAMS",
                            "Legacy draft must be text or null",
                        ))
                    }
                    None => self
                        .store
                        .read()?
                        .document
                        .legacy
                        .get("uterm.desktop.editorDraft.v1")
                        .cloned(),
                };
                serde_json::to_value(self.store.editor_import(source.as_deref())?)
                    .map_err(Into::into)
            }
            "editor.drafts.put" => serde_json::to_value(self.store.editor_put(
                &string(&params, "expectedRevision")?,
                serde_json::from_value(params["draft"].clone())?,
            )?)
            .map_err(Into::into),
            "editor.drafts.remove" => serde_json::to_value(self.store.editor_remove(
                &string(&params, "expectedRevision")?,
                &string(&params, "directory")?,
                &string(&params, "path")?,
            )?)
            .map_err(Into::into),
            "editor.drafts.recovery.list" => self.store.editor_recovery_list(),
            "editor.drafts.recovery.preview" => {
                serde_json::to_value(self.store.editor_preview(&string(&params, "revision")?)?)
                    .map_err(Into::into)
            }
            "editor.drafts.recovery.restoreMissing" => {
                if params.get("expectedMissing").and_then(Value::as_bool) != Some(true) {
                    return Err(CoreError::new(
                        "INVALID_ARGUMENT",
                        "Explicit expectedMissing acknowledgement is required",
                    ));
                }
                serde_json::to_value(
                    self.store
                        .editor_recover_missing(&string(&params, "revision")?)?,
                )
                .map_err(Into::into)
            }
            "editor.drafts.recovery.restore" => serde_json::to_value(self.store.editor_recover(
                &string(&params, "expectedRevision")?,
                &string(&params, "revision")?,
            )?)
            .map_err(Into::into),
            "snapshot.read" => serde_json::to_value(self.store.read()?).map_err(Into::into),
            "project.worktrees.delete" => serde_json::to_value(worktrees::delete_project_worktree(
                &self.store,
                self.data_root()?,
                params,
            )?)
            .map_err(Into::into),
            "project.worktrees.refresh" => {
                if !params.as_object().is_some_and(|fields| {
                    fields.len() == 2
                        && fields.contains_key("id")
                        && fields.contains_key("expectedRevision")
                }) {
                    return Err(CoreError::new(
                        "INVALID_ARGUMENT",
                        "Worktree refresh requires only a project ID and expected revision",
                    ));
                }
                let revision = string(&params, "expectedRevision")?;
                let id = string(&params, "id")?;
                let snapshot = self.store.read()?;
                if snapshot.revision != revision {
                    return Err(CoreError::new(
                        "CONFLICT",
                        "Workspace changed; refresh Worktrees again",
                    ));
                }
                let directory = snapshot.document.workspace["projects"]
                    .as_array()
                    .and_then(|projects| projects.iter().find(|project| project["id"] == id))
                    .and_then(|project| project["directory"].as_str())
                    .ok_or_else(|| CoreError::new("NOT_FOUND", "Project no longer exists"))?;
                let discovered = worktrees::project_worktrees(directory.into())
                    .map_err(|error| CoreError::new("GIT_ERROR", error))?;
                self.store
                    .update(&revision, |document| {
                        state::reconcile_worktrees(&mut document.workspace, &id, &discovered)
                    })
                    .and_then(|snapshot| serde_json::to_value(snapshot).map_err(Into::into))
            }
            "project.context" => {
                let snapshot = self.store.read()?;
                if string(&params, "expectedRevision")? != snapshot.revision {
                    return Err(CoreError::new(
                        "CONFLICT",
                        "Project selection changed; reload before opening its directory",
                    ));
                }
                serde_json::to_value(state::project_context(
                    &snapshot.document.workspace,
                    snapshot.revision,
                )?)
                .map_err(Into::into)
            }
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
                self.store.favorites_export(&mut legacy)?;
                self.store.pdf_export(&mut legacy)?;
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
            "rollback.export" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Arguments {
                    expected_revision: String,
                    expected_draft_revision: Option<String>,
                }
                let args: Arguments = serde_json::from_value(params)?;
                serde_json::to_value(self.store.rollback_export(
                    &args.expected_revision,
                    args.expected_draft_revision.as_deref(),
                )?)
                .map_err(Into::into)
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
fn draft_revision(params: &Value) -> Result<Option<&str>> {
    match params.get("expectedDraftRevision") {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value))
            if value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()) =>
        {
            Ok(Some(value))
        }
        _ => Err(CoreError::new(
            "INVALID_PARAMS",
            "An explicit document draft revision or null is required",
        )),
    }
}
fn java_result<T>(result: anyhow::Result<T>) -> Result<T> {
    result.map_err(|error| {
        let message = format!("{error:#}");
        let code = message
            .split(':')
            .next()
            .filter(|value| {
                value.contains('_') && value.chars().all(|c| c.is_ascii_uppercase() || c == '_')
            })
            .unwrap_or("JAVA_OPERATION_FAILED");
        CoreError::new(code, &message)
    })
}
fn python_result<T>(result: anyhow::Result<T>) -> Result<T> {
    result.map_err(|error| {
        let message = format!("{error:#}");
        let code = message
            .split(':')
            .next()
            .filter(|value| {
                value.starts_with("PYTHON_")
                    && value.chars().all(|c| c.is_ascii_uppercase() || c == '_')
            })
            .unwrap_or("PYTHON_OPERATION_FAILED");
        CoreError::new(code, &message)
    })
}
fn service_json(value: impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(Into::into)
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
