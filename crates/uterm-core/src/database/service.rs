use super::{Config, Host};
use crate::database_components;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::runtime::Runtime;

#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(rename = "DatabaseOperation")]
pub struct Operation {
    pub id: String,
    pub generation: String,
    pub kind: String,
    pub state: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "connect")]
    Connect {
        config: Config,
        password: Option<String>,
    },
    #[serde(rename = "request")]
    Query { handle: String, request: Value },
    #[serde(rename = "disconnect")]
    Disconnect { handle: String, discard: bool },
    #[serde(rename = "guard")]
    Guard { id: String, dirty: bool },
    #[serde(rename = "components")]
    Components {
        action: String,
        id: Option<String>,
        path: Option<PathBuf>,
    },
    #[serde(rename = "credential")]
    Credential {
        config: Config,
        password: Option<String>,
        remove: bool,
    },
    #[serde(rename = "prepareQuit")]
    Quit,
}
impl Request {
    fn kind(&self) -> &'static str {
        match self {
            Self::Connect { .. } => "connect",
            Self::Query { .. } => "request",
            Self::Disconnect { .. } => "disconnect",
            Self::Guard { .. } => "guard",
            Self::Components { .. } => "components",
            Self::Credential { .. } => "credential",
            Self::Quit => "prepareQuit",
        }
    }
    fn profile_safe(&self) -> bool {
        matches!(self, Self::Components { action, .. } if action == "status")
    }
    fn control(&self) -> bool {
        matches!(
            self,
            Self::Disconnect { .. } | Self::Guard { .. } | Self::Quit
        ) || matches!(self, Self::Components { action, .. } if action == "cancel")
    }
}

pub struct Service {
    runtime: Mutex<Option<Runtime>>,
    host: Host,
    operations: Arc<Mutex<HashMap<String, (Operation, bool, bool)>>>,
    events: Arc<Mutex<VecDeque<Value>>>,
    closed: Arc<AtomicBool>,
    quitting: Arc<AtomicBool>,
    pub identifier: String,
}
impl Service {
    pub fn new(mut host: Host) -> Result<Self> {
        let events = Arc::new(Mutex::new(VecDeque::<Value>::new()));
        let queue = events.clone();
        let emit = host.events.clone();
        host.events = Arc::new(move |kind, payload| {
            let mut values = queue.lock().map_err(|_| anyhow!("DB_OPERATION_FAILED"))?;
            // Coalesce progress so a slow UI cannot retain unbounded download events.
            // 合并进度，避免缓慢界面无限积压下载事件。
            values.retain(|value| value["kind"] != kind || value["payload"]["id"] != payload["id"]);
            if values.len() >= 64 {
                values.pop_front();
            }
            values.push_back(serde_json::json!({"kind":kind,"payload":payload}));
            drop(values);
            emit(kind, payload)
        });
        Ok(Self {
            runtime: Mutex::new(Some(
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()?,
            )),
            identifier: host.identifier.clone(),
            host,
            operations: Arc::default(),
            events,
            closed: Arc::default(),
            quitting: Arc::default(),
        })
    }
    pub fn start(&self, request: Request) -> Result<Operation> {
        let runtime = self.runtime.lock().map_err(|_| anyhow!("DB_CLOSED"))?;
        let runtime = runtime.as_ref().context("DB_CLOSED")?;
        let control = request.control();
        let profile_safe = request.profile_safe();
        let operation = Operation {
            id: uuid::Uuid::new_v4().to_string(),
            generation: uuid::Uuid::new_v4().to_string(),
            kind: request.kind().into(),
            state: "running".into(),
            result: None,
            error: None,
        };
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| anyhow!("DB_OPERATION_FAILED"))?;
        if self.closed.load(Ordering::Acquire) {
            bail!("DB_CLOSED");
        }
        if self.quitting.load(Ordering::Acquire)
            && !matches!(&request, Request::Disconnect { .. })
            && !matches!(&request, Request::Components { action, .. } if action == "cancel")
        {
            bail!("DB_QUITTING");
        }
        let preparing_quit = matches!(&request, Request::Quit);
        if preparing_quit
            && operations
                .values()
                .any(|(value, _, _)| value.state == "running")
        {
            bail!("DB_BUSY");
        }
        if operations
            .values()
            .filter(|(value, is_control, _)| *is_control == control && value.state == "running")
            .count()
            >= 8
        {
            bail!("DB_OPERATION_BUSY");
        }
        // Reserve result capacity at admission, while keeping disconnect/cancel available.
        // 接收操作时预留结果容量，同时保留断开／取消入口。
        if !control
            && operations
                .values()
                .filter(|(value, is_control, _)| {
                    !is_control && (value.state == "running" || value.result.is_some())
                })
                .count()
                >= 8
        {
            bail!("DB_RESULT_LIMIT");
        }
        if operations.len() >= 128 {
            operations.retain(|_, (value, is_control, _)| {
                value.state == "running" || (!*is_control && value.result.is_some())
            });
        }
        operations.insert(
            operation.id.clone(),
            (operation.clone(), control, profile_safe),
        );
        if preparing_quit {
            self.quitting.store(true, Ordering::Release);
        }
        drop(operations);
        let operations = self.operations.clone();
        let closed = self.closed.clone();
        let quitting = self.quitting.clone();
        let id = operation.id.clone();
        let host = self.host.clone();
        runtime.spawn(async move {
            let result = execute(host, request).await;
            if let Ok(mut operations) = operations.lock() {
                if let Some((value, _, _)) = operations.get_mut(&id) {
                    if closed.load(Ordering::Acquire) {
                        return;
                    }
                    match result {
                        Ok(result) => {
                            value.state = "completed".into();
                            value.result = Some(result);
                        }
                        Err(error) => {
                            if preparing_quit {
                                quitting.store(false, Ordering::Release);
                            }
                            value.state = "failed".into();
                            value.error = Some(sanitized_error(&error));
                        }
                    }
                }
            }
        });
        Ok(operation)
    }
    pub fn operations(&self) -> Result<Vec<Operation>> {
        Ok(self
            .operations
            .lock()
            .map_err(|_| anyhow!("DB_OPERATION_FAILED"))?
            .values()
            .map(|(value, _, _)| Operation {
                id: value.id.clone(),
                generation: value.generation.clone(),
                kind: value.kind.clone(),
                state: value.state.clone(),
                result: None,
                error: value.error.clone(),
            })
            .collect())
    }
    pub fn read(&self, id: &str, generation: &str, consume: bool) -> Result<Operation> {
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| anyhow!("DB_OPERATION_FAILED"))?;
        let (value, _, _) = operations.get_mut(id).context("DB_OPERATION_MISSING")?;
        if value.generation != generation {
            bail!("DB_OPERATION_CHANGED");
        }
        if value.state == "completed" && value.result.is_none() {
            bail!("DB_RESULT_CONSUMED");
        }
        if consume && value.state == "completed" {
            let mut response = value.clone();
            response.result = value.result.take();
            return Ok(response);
        }
        Ok(value.clone())
    }
    pub fn events(&self) -> Result<Vec<Value>> {
        Ok(self
            .events
            .lock()
            .map_err(|_| anyhow!("DB_OPERATION_FAILED"))?
            .drain(..)
            .collect())
    }
    pub fn status(&self) -> Result<Value> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| anyhow!("DB_OPERATION_FAILED"))?
            .values()
            .any(|(value, _, _)| value.state == "running");
        Ok(serde_json::json!({
            "operations":operations,
            "busy":self.host.database.busy() || self.host.components.0.load(Ordering::Acquire),
            "dirty":self.host.database.dirty(), "connected":self.host.database.in_use(),
            "closed":self.closed.load(Ordering::Acquire),
            "quitting":self.quitting.load(Ordering::Acquire),
        }))
    }
    pub fn resume(&self) -> Result<()> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| anyhow!("DB_OPERATION_FAILED"))?;
        if self.closed.load(Ordering::Acquire) {
            bail!("DB_CLOSED");
        }
        if operations
            .values()
            .any(|(value, _, _)| value.kind == "prepareQuit" && value.state == "running")
        {
            bail!("DB_BUSY");
        }
        self.quitting.store(false, Ordering::Release);
        Ok(())
    }
    pub(crate) fn with_profile_change<T>(
        &self,
        id: &str,
        change: impl FnOnce() -> crate::Result<T>,
    ) -> crate::Result<T> {
        // Hold admission through CAS persistence so a concurrent connect cannot use an edited profile.
        // CAS 保存期间持有接收保护，避免并发连接使用正在修改的配置。
        let operations = self
            .operations
            .lock()
            .map_err(|_| crate::CoreError::new("DB_CLOSED", "Database service is unavailable"))?;
        if self.closed.load(Ordering::Acquire) || self.quitting.load(Ordering::Acquire) {
            return Err(crate::CoreError::new(
                "DB_CLOSED",
                "Database client is closing",
            ));
        }
        if operations
            .values()
            // A component catalog read cannot use or mutate a saved connection profile.
            // 组件目录读取不会使用或修改已保存的连接配置。
            .any(|(value, _, profile_safe)| value.state == "running" && !profile_safe)
            || self.host.database.profile_in_use(id)
        {
            return Err(crate::CoreError::new(
                "DB_BUSY",
                "Disconnect and resolve drafts before changing this profile",
            ));
        }
        change()
    }
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.host.components.1.store(true, Ordering::Release);
        let runtime = self
            .runtime
            .lock()
            .ok()
            .and_then(|mut runtime| runtime.take());
        if let Some(runtime) = runtime {
            let handle = runtime.handle().clone();
            let database = self.host.database.clone();
            let _ = std::thread::spawn(move || handle.block_on(database.shutdown())).join();
            runtime.shutdown_background();
        }
        self.host.database.stop();
        if let Ok(mut operations) = self.operations.lock() {
            for (value, _, _) in operations.values_mut() {
                if value.state == "running" {
                    value.state = "failed".into();
                    value.error = Some("DB_CLOSED".into());
                }
                value.result = None;
            }
        }
        if let Ok(mut events) = self.events.lock() {
            events.clear();
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.close();
    }
}

fn sanitized_error(error: &str) -> String {
    // Keep numeric SQL locations for editor feedback without forwarding vendor messages.
    // 保留 SQL 数字位置供编辑器提示，不转发厂商错误文本。
    if error.starts_with("DB_SQL:") {
        static SQL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        if SQL.get_or_init(|| regex::Regex::new(r"\ADB_SQL:-?[0-9]{1,11}:(?:[A-Z0-9]{5}|null)(?::(?:POSITION|LINE):[0-9]{1,7})?\z").unwrap()).is_match(error) {
            return error.into();
        }
    }
    let code = error.split(':').next().unwrap_or_default();
    if (code.starts_with("DB_") || code.starts_with("SSH_"))
        && code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
    {
        code.into()
    } else {
        "DB_OPERATION_FAILED".into()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sql_diagnostics_preserve_locations_without_forwarding_private_vendor_text() {
        assert_eq!(
            super::sanitized_error("DB_SQL:0:42601:POSITION:13"),
            "DB_SQL:0:42601:POSITION:13"
        );
        assert_eq!(
            super::sanitized_error("DB_SQL:-1234:null:LINE:20"),
            "DB_SQL:-1234:null:LINE:20"
        );
        assert_eq!(
            super::sanitized_error("DB_SQL:0:42601:POSITION:13:PRIVATE_SQL_MARKER"),
            "DB_SQL"
        );
        assert_eq!(
            super::sanitized_error("PRIVATE_PASSWORD_MARKER"),
            "DB_OPERATION_FAILED"
        );
    }
}

async fn execute(mut host: Host, request: Request) -> std::result::Result<Value, String> {
    match request {
        Request::Connect { config, password } => {
            super::database_connect(host, config, password).await
        }
        Request::Query { handle, request } => super::database_request(host, handle, request).await,
        Request::Disconnect { handle, discard } => {
            super::database_disconnect(host, handle, discard)
                .await
                .map(|_| Value::Null)
        }
        Request::Guard { id, dirty } => {
            if id.is_empty() || id.len() > 128 {
                return Err("DB_INVALID_REQUEST".into());
            }
            super::database_guard(host, id, dirty).map(|_| Value::Null)
        }
        Request::Credential {
            config,
            password,
            remove,
        } => super::database_credential(host, config, password, remove)
            .await
            .map(|value| value.map_or(Value::Null, Value::String)),
        Request::Components { action, id, path } => {
            if let Some(path) = path {
                if !path.is_absolute() || !["import", "java"].contains(&action.as_str()) {
                    return Err("DB_INVALID_REQUEST".into());
                }
                host.pick_file = Arc::new(move || {
                    let path = path.clone();
                    Box::pin(async move { Ok(Some(path)) })
                });
            }
            serde_json::to_value(database_components::database_components(host, action, id).await?)
                .map_err(|_| "DB_OPERATION_FAILED".into())
        }
        Request::Quit => {
            if host.database.busy() || host.components.0.load(Ordering::Acquire) {
                Err("DB_BUSY".into())
            } else {
                Ok(Value::Null)
            }
        }
    }
}

#[cfg(test)]
mod profile_guard_tests {
    use super::*;

    #[test]
    fn suspended_catalog_reads_allow_profile_cas_but_mutating_operations_keep_the_guard() {
        let root = tempfile::tempdir().unwrap();
        let host = Host {
            database: Default::default(),
            components: Default::default(),
            data: root.path().join("data"),
            cache: root.path().join("cache"),
            identifier: "sh.uterm.qa.profile-read".into(),
            prepare_ssh: Arc::new(|_| Box::pin(async { bail!("Unexpected SSH") })),
            pick_file: Arc::new(|| Box::pin(async { Ok(None) })),
            events: Arc::new(|_, _| Ok(())),
        };
        let service = Service::new(host).unwrap();
        let edited = root.path().join("profile-cas");
        for action in ["status", "install", "import", "remove", "java", "cancel"] {
            let request = Request::Components {
                action: action.into(),
                id: None,
                path: None,
            };
            // Suspend admission records deterministically, without relying on JVM scheduling delays.
            // 确定性暂停已接收操作，不依赖 JVM 调度延迟。
            service.operations.lock().unwrap().insert(
                "pending".into(),
                (
                    Operation {
                        id: "pending".into(),
                        generation: "generation".into(),
                        kind: request.kind().into(),
                        state: "running".into(),
                        result: None,
                        error: None,
                    },
                    request.control(),
                    request.profile_safe(),
                ),
            );
            let result = service.with_profile_change("profile", || {
                std::fs::write(&edited, action)?;
                Ok(())
            });
            if action == "status" {
                assert!(result.is_ok());
            } else {
                assert_eq!(result.unwrap_err().code, "DB_BUSY");
            }
            assert_eq!(std::fs::read_to_string(&edited).unwrap(), "status");
        }
        service.close();
        assert_eq!(
            service
                .with_profile_change("profile", || Ok(()))
                .unwrap_err()
                .code,
            "DB_CLOSED"
        );
    }
}
