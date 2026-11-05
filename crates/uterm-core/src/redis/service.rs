use super::{Config, Host};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::runtime::Runtime;

#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(rename = "RedisOperation")]
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
    #[serde(rename = "reconnect")]
    Reconnect { handle: String },
    #[serde(rename = "request")]
    Query { handle: String, request: Value },
    #[serde(rename = "writable")]
    Writable { handle: String, writable: bool },
    #[serde(rename = "disconnect")]
    Disconnect { handle: String },
    #[serde(rename = "guard")]
    Guard { id: String, active: bool },
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
            Self::Reconnect { .. } => "reconnect",
            Self::Query { .. } => "request",
            Self::Writable { .. } => "writable",
            Self::Disconnect { .. } => "disconnect",
            Self::Guard { .. } => "guard",
            Self::Credential { .. } => "credential",
            Self::Quit => "prepareQuit",
        }
    }
    fn control(&self) -> bool {
        matches!(
            self,
            Self::Disconnect { .. } | Self::Guard { .. } | Self::Writable { .. } | Self::Quit
        )
    }
}
pub struct Service {
    runtime: Mutex<Option<Runtime>>,
    host: Host,
    operations: Arc<Mutex<HashMap<String, (Operation, bool)>>>,
    closed: Arc<AtomicBool>,
    quitting: Arc<AtomicBool>,
    pub identifier: String,
}
impl Service {
    pub fn new(host: Host) -> Result<Self> {
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
            closed: Arc::default(),
            quitting: Arc::default(),
        })
    }
    pub fn start(&self, request: Request) -> Result<Operation> {
        let runtime = self.runtime.lock().map_err(|_| anyhow!("REDIS_CLOSED"))?;
        let runtime = runtime.as_ref().context("REDIS_CLOSED")?;
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| anyhow!("REDIS_OPERATION_FAILED"))?;
        if self.closed.load(Ordering::Acquire) {
            bail!("REDIS_CLOSED");
        }
        if self.quitting.load(Ordering::Acquire) && !matches!(&request, Request::Disconnect { .. })
        {
            bail!("REDIS_QUITTING");
        }
        let preparing_quit = matches!(&request, Request::Quit);
        if preparing_quit
            && operations
                .values()
                .any(|(value, _)| value.state == "running")
        {
            bail!("REDIS_BUSY");
        }
        let control = request.control();
        if operations
            .values()
            .filter(|(value, is_control)| *is_control == control && value.state == "running")
            .count()
            >= 8
        {
            bail!("REDIS_OPERATION_BUSY");
        }
        // Reserve result capacity before execution, leaving separate control capacity for disconnect.
        // 执行前预留结果容量，为断开连接保留独立的控制容量。
        if !control
            && operations
                .values()
                .filter(|(value, is_control)| {
                    !is_control && (value.state == "running" || value.result.is_some())
                })
                .count()
                >= 8
        {
            bail!("REDIS_RESULT_LIMIT");
        }
        if operations.len() >= 128 {
            operations.retain(|_, (value, control)| {
                value.state == "running" || (!*control && value.result.is_some())
            });
        }
        let operation = Operation {
            id: uuid::Uuid::new_v4().to_string(),
            generation: uuid::Uuid::new_v4().to_string(),
            kind: request.kind().into(),
            state: "running".into(),
            result: None,
            error: None,
        };
        operations.insert(operation.id.clone(), (operation.clone(), control));
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
                if let Some((value, _)) = operations.get_mut(&id) {
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
            .map_err(|_| anyhow!("REDIS_OPERATION_FAILED"))?
            .values()
            .map(|(value, _)| Operation {
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
            .map_err(|_| anyhow!("REDIS_OPERATION_FAILED"))?;
        let (value, _) = operations.get_mut(id).context("REDIS_OPERATION_MISSING")?;
        if value.generation != generation {
            bail!("REDIS_OPERATION_CHANGED");
        }
        if value.state == "completed" && value.result.is_none() {
            bail!("REDIS_RESULT_CONSUMED");
        }
        let result = if consume && value.state == "completed" {
            value.result.take()
        } else {
            value.result.clone()
        };
        Ok(Operation {
            id: value.id.clone(),
            generation: value.generation.clone(),
            kind: value.kind.clone(),
            state: value.state.clone(),
            result,
            error: value.error.clone(),
        })
    }
    pub fn status(&self) -> Result<Value> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| anyhow!("REDIS_OPERATION_FAILED"))?
            .values()
            .any(|(value, _)| value.state == "running");
        let connected = self
            .host
            .state
            .connections
            .try_lock()
            .map_or(true, |values| !values.is_empty());
        Ok(
            json!({"operations":operations,"busy":self.host.state.busy(),"dirty":self.host.state.dirty(),"connected":connected,"closed":self.closed.load(Ordering::Acquire),"quitting":self.quitting.load(Ordering::Acquire)}),
        )
    }
    pub fn resume(&self) -> Result<()> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| anyhow!("REDIS_OPERATION_FAILED"))?;
        if self.closed.load(Ordering::Acquire) {
            bail!("REDIS_CLOSED");
        }
        if operations
            .values()
            .any(|(value, _)| value.kind == "prepareQuit" && value.state == "running")
        {
            bail!("REDIS_BUSY");
        }
        self.quitting.store(false, Ordering::Release);
        Ok(())
    }
    pub(crate) fn with_profile_change<T>(
        &self,
        id: &str,
        change: impl FnOnce() -> crate::Result<T>,
    ) -> crate::Result<T> {
        // Keep operation admission locked through the persisted profile revision check.
        // 持有操作接收锁直到配置持久化版本检查完成。
        let operations = self
            .operations
            .lock()
            .map_err(|_| crate::CoreError::new("REDIS_CLOSED", "Redis service is unavailable"))?;
        if self.closed.load(Ordering::Acquire) || self.quitting.load(Ordering::Acquire) {
            return Err(crate::CoreError::new(
                "REDIS_CLOSED",
                "Redis client is closing",
            ));
        }
        if operations
            .values()
            .any(|(value, _)| value.state == "running")
            || self.host.state.profile_in_use(id)
        {
            return Err(crate::CoreError::new(
                "REDIS_BUSY",
                "Disconnect and resolve drafts before changing this profile",
            ));
        }
        change()
    }
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(runtime) = self.runtime.lock().ok().and_then(|mut value| value.take()) {
            let state = self.host.state.clone();
            // Drain cancelled async tasks before reporting close; keep blocking OS work bounded.
            // 报告关闭前排空已取消异步任务，同时限制等待阻塞系统操作的时间。
            let _ = std::thread::spawn(move || {
                runtime.block_on(state.shutdown());
                runtime.shutdown_timeout(std::time::Duration::from_secs(1));
            })
            .join();
        }
        self.host.state.stop();
        if let Ok(mut operations) = self.operations.lock() {
            for (value, _) in operations.values_mut() {
                if value.state == "running" {
                    value.state = "failed".into();
                    value.error = Some("REDIS_CLOSED".into());
                }
                value.result = None;
            }
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.close();
    }
}
fn sanitized_error(error: &str) -> String {
    let code = error.split(':').next().unwrap_or("");
    if (code.starts_with("REDIS_") || code.starts_with("SSH_"))
        && code
            .bytes()
            .all(|value| value.is_ascii_uppercase() || value == b'_')
    {
        code.into()
    } else {
        "REDIS_OPERATION_FAILED".into()
    }
}
async fn execute(host: Host, request: Request) -> std::result::Result<Value, String> {
    match request {
        Request::Connect { config, password } => super::redis_connect(host, config, password).await,
        Request::Reconnect { handle } => super::redis_reconnect(host, handle).await,
        Request::Query { handle, request } => {
            let request = serde_json::from_value(request).map_err(|_| "REDIS_INVALID_REQUEST")?;
            super::redis_request(host, handle, request).await
        }
        Request::Writable { handle, writable } => super::redis_writable(host, handle, writable)
            .await
            .map(|_| Value::Null),
        Request::Disconnect { handle } => {
            super::redis_disconnect(host, handle).await;
            Ok(Value::Null)
        }
        Request::Guard { id, active } => super::redis_guard(host, id, active).map(|_| Value::Null),
        Request::Credential {
            config,
            password,
            remove,
        } => super::redis_credential(host, config, password, remove)
            .await
            .map(|value| value.map_or(Value::Null, Value::String)),
        Request::Quit => {
            if host.state.busy() {
                Err("REDIS_BUSY".into())
            } else {
                Ok(Value::Null)
            }
        }
    }
}
