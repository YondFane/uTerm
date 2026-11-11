use super::{Host, Status};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::runtime::Runtime;

#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(rename = "JavaComponentOperation")]
pub struct Operation {
    pub id: String,
    pub generation: String,
    pub state: String,
    pub result: Option<Status>,
    pub error: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(rename = "JavaComponentProgress")]
pub struct Progress {
    pub id: String,
    pub received: u32,
    pub total: u32,
}

#[derive(Default)]
struct State {
    closed: bool,
    operation: Option<(Operation, bool)>,
    progress: Option<Progress>,
}

pub struct Service {
    host: Host,
    state: Arc<Mutex<State>>,
    runtime: Mutex<Option<Runtime>>,
}
impl Service {
    pub fn new(mut host: Host) -> Self {
        let state = Arc::new(Mutex::new(State::default()));
        let current = state.clone();
        let emit = host.events.clone();
        host.events = Arc::new(move |kind, value| {
            if kind == "java-component-progress" {
                let mut current = current
                    .lock()
                    .map_err(|_| anyhow!("JAVA_OPERATION_FAILED"))?;
                if current.closed {
                    return Ok(());
                }
                current.progress = Some(serde_json::from_value(value.clone())?);
            }
            emit(kind, value)
        });
        Self {
            host,
            state,
            runtime: Mutex::new(None),
        }
    }
    pub fn status(&self) -> Result<Status> {
        if self
            .state
            .lock()
            .map_err(|_| anyhow!("JAVA_OPERATION_FAILED"))?
            .closed
        {
            bail!("JAVA_COMPONENT_CLOSED");
        }
        let mut status = super::status(&self.host)?;
        status.busy |= self
            .active()?
            .is_some_and(|operation| operation.state == "running");
        Ok(status)
    }
    pub fn progress(&self) -> Result<Option<Progress>> {
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow!("JAVA_OPERATION_FAILED"))?;
        if state.closed {
            bail!("JAVA_COMPONENT_CLOSED");
        }
        Ok(state.progress.clone())
    }
    pub fn active(&self) -> Result<Option<Operation>> {
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow!("JAVA_OPERATION_FAILED"))?;
        if state.closed {
            bail!("JAVA_COMPONENT_CLOSED");
        }
        Ok(state
            .operation
            .as_ref()
            .filter(|(_, consumed)| !consumed)
            .map(|(value, _)| value.clone()))
    }
    pub fn start(&self, action: String, id: String, path: Option<PathBuf>) -> Result<Operation> {
        if !["install", "import"].contains(&action.as_str())
            || (action == "import") != path.is_some()
        {
            bail!("JAVA_TASK_INVALID");
        }
        super::catalog(&self.host)?
            .get(&id)
            .context("JAVA_COMPONENT_MISSING")?;
        if path
            .as_ref()
            .is_some_and(|path| !path.is_absolute() || !path.is_file())
        {
            bail!("JAVA_COMPONENT_INVALID");
        }
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| anyhow!("JAVA_OPERATION_FAILED"))?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("JAVA_OPERATION_FAILED"))?;
        if state.closed {
            bail!("JAVA_COMPONENT_CLOSED");
        }
        // Keep a completed result until consumed; a new operation cannot silently evict it.
        // 保留已完成结果直到消费，新操作不能静默替换它。
        if state
            .operation
            .as_ref()
            .is_some_and(|(_, consumed)| !consumed)
        {
            bail!("JAVA_TASK_BUSY");
        }
        if runtime.is_none() {
            *runtime = Some(
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()?,
            );
        }
        let guard = super::begin(&self.host, &action, &id, path.as_deref())?;
        let operation = Operation {
            id: uuid::Uuid::new_v4().to_string(),
            generation: uuid::Uuid::new_v4().to_string(),
            state: "running".into(),
            result: None,
            error: None,
        };
        state.operation = Some((operation.clone(), false));
        state.progress = None;
        let current = self.state.clone();
        let host = self.host.clone();
        let handle = operation.clone();
        let task = runtime
            .as_ref()
            .unwrap()
            .spawn(async move { super::execute_reserved(host, id, path, guard).await });
        runtime.as_ref().unwrap().spawn(async move {
            let result = task
                .await
                .unwrap_or_else(|_| Err(anyhow!("JAVA_OPERATION_FAILED")));
            if let Ok(mut current) = current.lock() {
                if let Some((operation, _)) = &mut current.operation {
                    if operation.id == handle.id && operation.generation == handle.generation {
                        operation.state = if result.is_ok() {
                            "completed"
                        } else {
                            "failed"
                        }
                        .into();
                        match result {
                            Ok(value) => operation.result = Some(value),
                            Err(error) => operation.error = Some(error.to_string()),
                        }
                    }
                }
            }
        });
        Ok(operation)
    }
    pub fn read(&self, id: &str, generation: &str, consume: bool) -> Result<Operation> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("JAVA_OPERATION_FAILED"))?;
        if state.closed {
            bail!("JAVA_COMPONENT_CLOSED");
        }
        let (operation, consumed) = state
            .operation
            .as_mut()
            .filter(|(operation, _)| operation.id == id && operation.generation == generation)
            .context("JAVA_OPERATION_STALE")?;
        if *consumed {
            bail!("JAVA_RESULT_CONSUMED");
        }
        if consume && operation.state != "running" {
            *consumed = true;
        }
        Ok(operation.clone())
    }
    pub fn cancel(&self, id: &str, generation: &str) -> Result<Operation> {
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow!("JAVA_OPERATION_FAILED"))?;
        if state.closed {
            bail!("JAVA_COMPONENT_CLOSED");
        }
        let operation = state
            .operation
            .as_ref()
            .filter(|(operation, _)| operation.id == id && operation.generation == generation)
            .context("JAVA_OPERATION_STALE")?
            .0
            .clone();
        if operation.state == "running" {
            self.host.components.cancel();
        }
        Ok(operation)
    }
    pub fn close(&self) {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.closed = true;
        self.host.components.close();
        if let Some(runtime) = runtime.take() {
            runtime.shutdown_background();
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database_components::Artifact;
    use sha2::{Digest, Sha256};
    use std::{collections::HashMap, io::Read, net::TcpListener, sync::mpsc, time::Duration};

    fn host(root: &std::path::Path, url: String, bytes: &[u8]) -> Host {
        let mut host = Host::new(root.into());
        host.catalog = Some(Arc::new(HashMap::from([(
            "maven".into(),
            Artifact {
                version: "test".into(),
                filename: "maven.zip".into(),
                size: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
                url,
            },
        )])));
        host
    }
    fn finished(service: &Service, operation: &Operation) -> Operation {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let value = service
                .read(&operation.id, &operation.generation, false)
                .unwrap();
            if value.state != "running" {
                return value;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "component operation did not finish"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn failed_import_keeps_source_and_result_until_consumed_then_allows_retry() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"verified bytes, invalid archive";
        let source = root.path().join("literal 中文 & %.zip");
        std::fs::write(&source, bytes).unwrap();
        let service = Service::new(host(
            root.path(),
            "https://example.invalid/maven.zip".into(),
            bytes,
        ));
        let operation = service
            .start("import".into(), "maven".into(), Some(source.clone()))
            .unwrap();
        let failed = finished(&service, &operation);
        assert_eq!(failed.state, "failed");
        assert!(failed.error.is_some());
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
        assert!(!crate::java::managed_root(root.path())
            .unwrap()
            .join("maven/home.txt")
            .exists());
        assert!(service
            .start("import".into(), "maven".into(), Some(source.clone()))
            .err()
            .unwrap()
            .to_string()
            .contains("JAVA_TASK_BUSY"));
        assert!(service
            .cancel(&operation.id, "stale")
            .err()
            .unwrap()
            .to_string()
            .contains("JAVA_OPERATION_STALE"));
        service
            .read(&operation.id, &operation.generation, true)
            .unwrap();
        assert!(service.active().unwrap().is_none());
        assert!(service
            .read(&operation.id, &operation.generation, true)
            .err()
            .unwrap()
            .to_string()
            .contains("JAVA_RESULT_CONSUMED"));
        let retry = service
            .start("import".into(), "maven".into(), Some(source))
            .unwrap();
        assert_ne!(retry.id, operation.id);
        assert_ne!(retry.generation, operation.generation);
        assert_eq!(finished(&service, &retry).state, "failed");
        service.close();
        assert!(service
            .status()
            .err()
            .unwrap()
            .to_string()
            .contains("JAVA_COMPONENT_CLOSED"));
    }

    #[test]
    fn closing_an_inflight_service_cancels_the_worker_and_prevents_install_commit() {
        let root = tempfile::tempdir().unwrap();
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let (ready, received) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = [0; 4096];
            assert!(socket.read(&mut bytes).unwrap() > 0);
            ready.send(()).unwrap();
            let _ = wait.recv_timeout(Duration::from_secs(5));
        });
        let service = Service::new(host(
            root.path(),
            format!("http://{address}/maven.zip"),
            b"pending",
        ));
        let operation = service
            .start("install".into(), "maven".into(), None)
            .unwrap();
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        service.close();
        assert!(service
            .read(&operation.id, &operation.generation, false)
            .err()
            .unwrap()
            .to_string()
            .contains("JAVA_COMPONENT_CLOSED"));
        assert!(service
            .start("install".into(), "maven".into(), None)
            .err()
            .unwrap()
            .to_string()
            .contains("JAVA_COMPONENT_CLOSED"));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while service
            .host
            .components
            .busy
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            assert!(
                std::time::Instant::now() < deadline,
                "closed worker retained installation lease"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!crate::java::managed_root(root.path())
            .unwrap()
            .join("maven/home.txt")
            .exists());
        let _ = release.send(());
        worker.join().unwrap();
    }

    #[test]
    fn stale_cancel_cannot_stop_download_but_matching_cancel_releases_real_worker() {
        let root = tempfile::tempdir().unwrap();
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let (ready, received) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = [0; 4096];
            assert!(socket.read(&mut bytes).unwrap() > 0);
            ready.send(()).unwrap();
            let _ = wait.recv_timeout(Duration::from_secs(5));
        });
        let service = Service::new(host(
            root.path(),
            format!("http://{address}/maven.zip"),
            b"pending",
        ));
        let operation = service
            .start("install".into(), "maven".into(), None)
            .unwrap();
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(service.cancel(&operation.id, "stale").is_err());
        assert!(!service
            .host
            .components
            .cancelled
            .load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(
            service
                .read(&operation.id, &operation.generation, true)
                .unwrap()
                .state,
            "running"
        );
        service
            .cancel(&operation.id, &operation.generation)
            .unwrap();
        let cancelled = finished(&service, &operation);
        assert_eq!(cancelled.state, "failed");
        assert!(cancelled.error.unwrap().contains("CANCELLED"));
        service
            .read(&operation.id, &operation.generation, true)
            .unwrap();
        assert!(service.active().unwrap().is_none());
        assert!(!service
            .host
            .components
            .busy
            .load(std::sync::atomic::Ordering::SeqCst));
        let _ = release.send(());
        worker.join().unwrap();
    }
}
