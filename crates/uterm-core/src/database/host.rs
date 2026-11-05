use super::DatabaseState;
use crate::{database_components::Components, ssh::auth::Prepared};
use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc};
use utermd_local::ssh::SshTarget;

pub type HostFuture<T> = Pin<Box<dyn Future<Output = Result<T>> + Send>>;
pub type Prepare = Arc<dyn Fn(SshTarget) -> HostFuture<Prepared> + Send + Sync>;
pub type PickFile = Arc<dyn Fn() -> HostFuture<Option<PathBuf>> + Send + Sync>;
pub type Events = Arc<dyn Fn(&str, Value) -> Result<()> + Send + Sync>;

// Clients supply application paths and native UI ports; shared services own the business rules.
// 客户端提供应用目录和原生界面接口，共享服务管理业务规则。
#[derive(Clone)]
pub struct Host {
    pub database: DatabaseState,
    pub components: Components,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub identifier: String,
    pub prepare_ssh: Prepare,
    pub pick_file: PickFile,
    pub events: Events,
}
impl Host {
    pub fn emit(&self, event: &str, payload: impl Serialize) -> Result<()> {
        (self.events)(event, serde_json::to_value(payload)?)
    }
}
