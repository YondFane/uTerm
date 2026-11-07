use super::RedisState;
use crate::ssh::auth::Prepared;
use std::{future::Future, pin::Pin, sync::Arc};
use utermd_local::ssh::SshTarget;

pub type Prepare = Arc<
    dyn Fn(SshTarget) -> Pin<Box<dyn Future<Output = anyhow::Result<Prepared>> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct Host {
    pub state: RedisState,
    pub identifier: String,
    pub prepare_ssh: Prepare,
}
