use super::{
    auth::{Prepared, SshAuth},
    files::{self, RemoteRoot, SshFiles, TransferGuard},
    tunnels::{Forward, SshTunnels},
};
use crate::credentials::{Credentials, SystemCredentials};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tokio::runtime::{Handle, Runtime};
use utermd_local::ssh::SshTarget;

#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(rename = "SshProgress")]
pub struct Progress {
    pub name: String,
    pub completed: String,
    pub total: String,
}
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(rename = "SshOperation")]
pub struct Operation {
    pub id: String,
    pub generation: String,
    pub kind: String,
    pub state: String,
    pub progress: Option<Progress>,
    pub result: Option<Value>,
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(rename = "SshTrustPrompt")]
pub struct TrustPrompt {
    pub id: String,
    pub message: String,
}
struct Confirmation {
    prompt: TrustPrompt,
    reply: mpsc::SyncSender<bool>,
}
#[derive(Default)]
struct Trust {
    values: Mutex<HashMap<String, Confirmation>>,
    closed: AtomicBool,
}
impl Trust {
    fn request(&self, message: &str) -> bool {
        let (reply, receiver) = mpsc::sync_channel(1);
        let id = uuid::Uuid::new_v4().to_string();
        {
            let Ok(mut values) = self.values.lock() else {
                return false;
            };
            if self.closed.load(Ordering::Acquire) || values.len() >= 32 {
                return false;
            }
            values.insert(
                id.clone(),
                Confirmation {
                    prompt: TrustPrompt {
                        id: id.clone(),
                        message: message.to_owned(),
                    },
                    reply,
                },
            );
        }
        let approved = receiver
            .recv_timeout(Duration::from_secs(110))
            .unwrap_or(false);
        if let Ok(mut values) = self.values.lock() {
            values.remove(&id);
        }
        approved
    }
    fn clear(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut values) = self.values.lock() {
            for (_, value) in values.drain() {
                let _ = value.reply.try_send(false);
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "config.resolve")]
    Resolve { connection: SshTarget },
    #[serde(rename = "auth.configure")]
    Configure {
        connection: SshTarget,
        password: Option<String>,
        remember: bool,
    },
    #[serde(rename = "auth.forget")]
    Forget { reference: String, remember: bool },
    #[serde(rename = "files.open")]
    Open {
        connection: SshTarget,
        expected: Option<RemoteRoot>,
    },
    #[serde(rename = "files.list")]
    List {
        root: RemoteRoot,
        path: String,
        hidden: bool,
    },
    #[serde(rename = "files.read")]
    Read { root: RemoteRoot, path: String },
    #[serde(rename = "files.save")]
    Save {
        root: RemoteRoot,
        path: String,
        text: String,
        expected: String,
        force: bool,
    },
    #[serde(rename = "files.mutate")]
    Mutate {
        root: RemoteRoot,
        path: String,
        action: String,
        name: String,
    },
    #[serde(rename = "files.transfer")]
    Transfer {
        root: RemoteRoot,
        path: String,
        direction: String,
        paths: Vec<PathBuf>,
        overwrite: bool,
    },
    #[serde(rename = "files.disconnect")]
    Disconnect { connection_id: String },
    #[serde(rename = "prepareQuit")]
    Quit,
}
impl Request {
    fn kind(&self) -> &'static str {
        match self {
            Self::Resolve { .. } => "config.resolve",
            Self::Configure { .. } => "auth.configure",
            Self::Forget { .. } => "auth.forget",
            Self::Open { .. } => "files.open",
            Self::List { .. } => "files.list",
            Self::Read { .. } => "files.read",
            Self::Save { .. } => "files.save",
            Self::Mutate { .. } => "files.mutate",
            Self::Transfer { .. } => "files.transfer",
            Self::Disconnect { .. } => "files.disconnect",
            Self::Quit => "prepareQuit",
        }
    }
}

pub struct Service {
    runtime: Mutex<Option<Runtime>>,
    files: Arc<SshFiles>,
    tunnels: Arc<SshTunnels>,
    auth: Arc<SshAuth>,
    credentials: Arc<dyn Credentials>,
    trust: Arc<Trust>,
    operations: Arc<Mutex<HashMap<String, Operation>>>,
    closed: Arc<AtomicBool>,
    quitting: Arc<AtomicBool>,
    pub namespace: String,
}
impl Service {
    pub fn new(namespace: String) -> Result<Self> {
        let credentials = Arc::new(SystemCredentials::new(namespace.clone())?);
        Self::with_credentials(namespace, credentials)
    }
    pub fn with_credentials(namespace: String, credentials: Arc<dyn Credentials>) -> Result<Self> {
        Ok(Self {
            runtime: Mutex::new(Some(
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()?,
            )),
            files: Arc::new(SshFiles::default()),
            tunnels: Arc::new(SshTunnels::default()),
            auth: Arc::new(SshAuth::default()),
            credentials,
            trust: Arc::new(Trust::default()),
            operations: Arc::new(Mutex::new(HashMap::new())),
            closed: Arc::new(AtomicBool::new(false)),
            quitting: Arc::new(AtomicBool::new(false)),
            namespace,
        })
    }
    fn handle(&self) -> Result<Handle> {
        if self.closed.load(Ordering::Acquire) {
            bail!("SSH_CLOSED");
        }
        Ok(self
            .runtime
            .lock()
            .map_err(|_| anyhow!("SSH_CLOSED"))?
            .as_ref()
            .context("SSH_CLOSED")?
            .handle()
            .clone())
    }
    pub fn prepare(&self, connection: SshTarget) -> Result<Prepared> {
        let handle = self.handle()?;
        let auth = self.auth.clone();
        let credentials = self.credentials.clone();
        let trust = self.trust.clone();
        std::thread::spawn(move || {
            handle.block_on(auth.prepare(&connection, credentials, move |message| {
                trust.request(message)
            }))
        })
        .join()
        .map_err(|_| anyhow!("SSH_AUTH_FAILED"))?
    }
    pub fn prompts(&self) -> Result<Vec<TrustPrompt>> {
        Ok(self
            .trust
            .values
            .lock()
            .map_err(|_| anyhow!("SSH_AUTH_FAILED"))?
            .values()
            .map(|v| v.prompt.clone())
            .collect())
    }
    pub fn confirm(&self, id: &str, approve: bool) -> Result<()> {
        let confirmation = self
            .trust
            .values
            .lock()
            .map_err(|_| anyhow!("SSH_AUTH_FAILED"))?
            .remove(id)
            .context("SSH_TRUST_EXPIRED")?;
        confirmation
            .reply
            .try_send(approve)
            .map_err(|_| anyhow!("SSH_TRUST_EXPIRED"))
    }
    pub fn operations(&self) -> Result<Vec<Operation>> {
        Ok(self
            .operations
            .lock()
            .map_err(|_| anyhow!("SSH_OPERATION_FAILED"))?
            .values()
            .map(|value| Operation {
                id: value.id.clone(),
                generation: value.generation.clone(),
                kind: value.kind.clone(),
                state: value.state.clone(),
                progress: value.progress.clone(),
                result: None,
                error: value.error.clone(),
            })
            .collect())
    }
    pub fn read(&self, id: &str, generation: &str, consume: bool) -> Result<Operation> {
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| anyhow!("SSH_OPERATION_FAILED"))?;
        let value = operations.get_mut(id).context("SSH_OPERATION_MISSING")?;
        if value.generation != generation {
            bail!("SSH_OPERATION_CHANGED");
        }
        if value.state == "completed" && value.result.is_none() {
            bail!("SSH_OPERATION_RESULT_CONSUMED");
        }
        if consume && value.state == "completed" {
            let result = value.result.take();
            let mut response = value.clone();
            response.result = result;
            return Ok(response);
        }
        Ok(value.clone())
    }
    pub fn cancel(&self, id: &str, generation: &str) -> Result<()> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| anyhow!("SSH_OPERATION_FAILED"))?;
        let operation = operations.get(id).context("SSH_OPERATION_MISSING")?;
        if operation.generation != generation {
            bail!("SSH_OPERATION_CHANGED");
        }
        if operation.kind != "files.transfer" || operation.state != "running" {
            bail!("SSH_OPERATION_NOT_CANCELLABLE");
        }
        self.files
            .cancel_generation(id, Some(uuid::Uuid::parse_str(generation)?))
    }
    pub fn start(&self, request: Request) -> Result<Operation> {
        let handle = self.handle()?;
        if self.quitting.load(Ordering::Acquire) {
            bail!("SSH_QUITTING");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let transfer = if matches!(request, Request::Transfer { .. }) {
            Some(self.files.begin_transfer(&id)?)
        } else {
            None
        };
        let generation = transfer
            .as_ref()
            .map(|v| v.generation)
            .unwrap_or_else(uuid::Uuid::new_v4)
            .to_string();
        let status = Operation {
            id: id.clone(),
            generation,
            kind: request.kind().into(),
            state: "running".into(),
            progress: None,
            result: None,
            error: None,
        };
        {
            let mut operations = self
                .operations
                .lock()
                .map_err(|_| anyhow!("SSH_OPERATION_FAILED"))?;
            if operations.values().filter(|v| v.state == "running").count() >= 8 {
                bail!("SSH_OPERATION_BUSY");
            }
            if matches!(request, Request::Read { .. })
                && operations
                    .values()
                    .filter(|v| v.kind == "files.read" && v.result.is_some())
                    .count()
                    >= 4
            {
                bail!("SSH_OPERATION_BUSY");
            }
            if operations.len() >= 128 {
                operations.retain(|_, v| v.state == "running");
            }
            if self.quitting.load(Ordering::Acquire) {
                bail!("SSH_QUITTING");
            }
            if matches!(request, Request::Quit) {
                if operations
                    .values()
                    .any(|v| v.state == "running" && v.kind != "files.transfer")
                {
                    bail!("SSH_OPERATION_BUSY");
                }
                self.quitting.store(true, Ordering::Release);
            }
            operations.insert(id.clone(), status.clone());
        }
        let files = self.files.clone();
        let auth = self.auth.clone();
        let credentials = self.credentials.clone();
        let trust = self.trust.clone();
        let operations = self.operations.clone();
        let closed = self.closed.clone();
        let tunnels = self.tunnels.clone();
        let quitting = self.quitting.clone();
        handle.spawn(async move {
            let result = execute(
                request,
                &files,
                &auth,
                credentials,
                trust,
                transfer,
                &id,
                operations.clone(),
                closed.clone(),
                &tunnels,
            )
            .await;
            if let Ok(mut operations) = operations.lock() {
                if let Some(operation) = operations.get_mut(&id) {
                    match result {
                        Ok(value) => {
                            operation.state = "completed".into();
                            operation.result = Some(value);
                        }
                        Err(error) => {
                            if operation.kind == "prepareQuit" {
                                quitting.store(false, Ordering::Release);
                            }
                            operation.state =
                                if error.to_string().contains("SSH_TRANSFER_CANCELLED") {
                                    "cancelled"
                                } else {
                                    "failed"
                                }
                                .into();
                            operation.error = Some(error.to_string());
                        }
                    }
                }
            }
        });
        Ok(status)
    }
    pub fn tunnel_start(&self, connection: SshTarget, rule: Forward) -> Result<Value> {
        let _admission = self
            .operations
            .lock()
            .map_err(|_| anyhow!("SSH_OPERATION_FAILED"))?;
        if self.quitting.load(Ordering::Acquire) {
            bail!("SSH_QUITTING");
        }
        let handle = self.handle()?;
        let auth = self.auth.clone();
        let credentials = self.credentials.clone();
        let trust = self.trust.clone();
        let target = connection.clone();
        let _runtime = handle.enter();
        self.tunnels
            .start(
                async move {
                    auth.prepare(&target, credentials, move |message| trust.request(message))
                        .await
                },
                connection,
                rule,
            )
            .map(|v| json!(v))
            .map_err(anyhow::Error::msg)
    }
    pub fn tunnel_list(&self) -> Result<Value> {
        let handle = self.handle()?;
        let tunnels = self.tunnels.clone();
        std::thread::spawn(move || handle.block_on(tunnels.list()))
            .join()
            .map_err(|_| anyhow!("SSH_FORWARD_FAILED"))?
            .map(|v| json!(v))
            .map_err(anyhow::Error::msg)
    }
    pub fn tunnel_stop(&self, connection_id: String, id: String, generation: String) -> Result<()> {
        let handle = self.handle()?;
        let tunnels = self.tunnels.clone();
        std::thread::spawn(move || {
            handle.block_on(tunnels.stop_generation(connection_id, id, Some(generation)))
        })
        .join()
        .map_err(|_| anyhow!("SSH_FORWARD_FAILED"))?
        .map_err(anyhow::Error::msg)
    }
    pub fn resume(&self) -> Result<()> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| anyhow!("SSH_OPERATION_FAILED"))?;
        if operations
            .values()
            .any(|v| v.state == "running" && v.kind == "prepareQuit")
        {
            bail!("SSH_QUITTING");
        }
        self.quitting.store(false, Ordering::Release);
        Ok(())
    }
    pub fn connection_busy(&self, id: &str) -> Result<bool> {
        let handle = self.handle()?;
        let files = self.files.clone();
        let tunnels = self.tunnels.clone();
        let id = id.to_owned();
        std::thread::spawn(move || {
            handle.block_on(async {
                Ok(files.connected(&id).await
                    || tunnels
                        .list()
                        .await
                        .map_err(anyhow::Error::msg)?
                        .iter()
                        .any(|v| v.connection_id == id && v.state != "error"))
            })
        })
        .join()
        .map_err(|_| anyhow!("SSH_OPERATION_FAILED"))?
    }
    pub fn busy(&self) -> bool {
        self.operations.lock().map_or(true, |operations| {
            operations.values().any(|v| v.state == "running")
        })
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.files.stop();
        self.tunnels.stop();
        self.trust.clear();
        self.auth.clear();
        if let Ok(mut runtime) = self.runtime.lock() {
            if let Some(runtime) = runtime.take() {
                runtime.shutdown_background();
            }
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.close();
    }
}

async fn execute(
    request: Request,
    files: &SshFiles,
    auth: &SshAuth,
    credentials: Arc<dyn Credentials>,
    trust: Arc<Trust>,
    transfer: Option<TransferGuard>,
    id: &str,
    operations: Arc<Mutex<HashMap<String, Operation>>>,
    closed: Arc<AtomicBool>,
    tunnels: &SshTunnels,
) -> Result<Value> {
    let prepare = |connection: SshTarget| {
        let trust = trust.clone();
        let credentials = credentials.clone();
        async move {
            auth.prepare(&connection, credentials, move |message| {
                trust.request(message)
            })
            .await
        }
    };
    match request {
        Request::Resolve { connection } => Ok(json!(super::Resolution::from(
            super::effective_target(&connection).await?
        ))),
        Request::Configure {
            connection,
            password,
            remember,
        } => Ok(json!(
            auth.configure(credentials, connection, password, remember)
                .await?
        )),
        Request::Forget {
            reference,
            remember,
        } => {
            auth.forget(credentials, reference, remember).await?;
            Ok(Value::Null)
        }
        Request::Open {
            connection,
            expected,
        } => {
            let prepared = prepare(connection.clone()).await?;
            Ok(json!(files.open(connection, expected, prepared).await?))
        }
        Request::List { root, path, hidden } => files::ssh_files_list(files, root, path, hidden)
            .await
            .map(|v| json!(v))
            .map_err(anyhow::Error::msg),
        Request::Read { root, path } => files::ssh_file_read(files, root, path)
            .await
            .map(|v| json!(v))
            .map_err(anyhow::Error::msg),
        Request::Save {
            root,
            path,
            text,
            expected,
            force,
        } => files::ssh_file_save(files, root, path, text, expected, force)
            .await
            .map(|v| json!(v))
            .map_err(anyhow::Error::msg),
        Request::Mutate {
            root,
            path,
            action,
            name,
        } => files::ssh_file_mutate(files, root, path, action, name)
            .await
            .map(|_| Value::Null)
            .map_err(anyhow::Error::msg),
        Request::Transfer {
            root,
            path,
            direction,
            paths,
            overwrite,
        } => {
            let progress = move |value: files::TransferProgress| {
                if closed.load(Ordering::Acquire) {
                    bail!("SSH_CLOSED");
                }
                if let Some(operation) = operations
                    .lock()
                    .map_err(|_| anyhow!("SSH_OPERATION_FAILED"))?
                    .get_mut(id)
                {
                    operation.progress = Some(Progress {
                        name: value.name,
                        completed: value.completed.to_string(),
                        total: value.total.to_string(),
                    });
                }
                Ok(())
            };
            files
                .transfer(
                    &root,
                    &path,
                    &direction,
                    paths,
                    overwrite,
                    &transfer.context("SSH_INVALID_ACTION")?,
                    &progress,
                )
                .await?;
            Ok(Value::Null)
        }
        Request::Disconnect { connection_id } => {
            files.disconnect(&connection_id).await?;
            Ok(Value::Null)
        }
        Request::Quit => {
            files.cancel_and_disconnect().await?;
            tunnels.stop();
            Ok(Value::Null)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trust_replies_are_single_use_and_close_rejects_late_prompts() {
        let service = Service::new(format!("sh.uterm.qa.{}", uuid::Uuid::new_v4())).unwrap();
        let trust = service.trust.clone();
        let pending = std::thread::spawn(move || trust.request("Isolated host fingerprint"));
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let id = loop {
            if let Some(prompt) = service.prompts().unwrap().first() {
                break prompt.id.clone();
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        };
        service.confirm(&id, true).unwrap();
        assert!(pending.join().unwrap());
        assert_eq!(
            service.confirm(&id, true).unwrap_err().to_string(),
            "SSH_TRUST_EXPIRED"
        );
        let trust = service.trust.clone();
        let pending = std::thread::spawn(move || trust.request("Cancel during close"));
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while service.prompts().unwrap().is_empty() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        service.close();
        assert!(!pending.join().unwrap());
        assert!(!service.trust.request("Late prompt"));
        assert_eq!(
            service.start(Request::Quit).err().unwrap().to_string(),
            "SSH_CLOSED"
        );
    }
}
