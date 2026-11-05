use crate::credentials::Credentials;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use utermd_local::{
    ssh::{ResolvedTarget, SshTarget},
    ssh_askpass::{Endpoint, Server},
};

#[derive(Clone, Serialize, Deserialize)]
struct Credential {
    target: String,
    password: String,
}
#[derive(Default)]
pub struct SshAuth {
    temporary: Mutex<HashMap<String, Credential>>,
    pending: Mutex<Vec<Server>>,
}
#[derive(Clone)]
pub struct Prepared {
    pub effective: super::EffectiveSsh,
    pub askpass: Option<Endpoint>,
    #[cfg(test)]
    pub(crate) configuration: Option<std::path::PathBuf>,
}
impl Prepared {
    pub fn resolved(&self) -> Result<ResolvedTarget> {
        Ok(ResolvedTarget {
            hostname: self.effective.hostname.clone(),
            user: self.effective.user.clone(),
            port: self.effective.port.parse()?,
        })
    }
    pub fn apply(&self, command: &mut std::process::Command) -> Result<()> {
        #[cfg(test)]
        if let Some(configuration) = &self.configuration {
            command.arg("-F").arg(configuration);
        }
        if let Some(endpoint) = &self.askpass {
            command.envs(endpoint.environment()?);
            command.args(["-o", "ProxyCommand=none", "-o", "ProxyJump=none"]);
        }
        Ok(())
    }
}
fn target(connection: &SshTarget, effective: &super::EffectiveSsh) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{}\n{}", connection.connection_id, effective.identity).as_bytes())
    )
}
impl SshAuth {
    async fn load(
        &self,
        credentials: Arc<dyn Credentials>,
        connection: &SshTarget,
        target: &str,
    ) -> Result<Credential> {
        let id = connection
            .credential_id
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("SSH_PASSWORD_REQUIRED"))?;
        let value = if connection.remember_password == Some(true) {
            let reference = id.clone();
            let bytes = tokio::task::spawn_blocking(move || credentials.access(&reference, None))
                .await?
                .map_err(|_| anyhow::anyhow!("SSH_CREDENTIAL_FAILED"))?
                .ok_or_else(|| anyhow::anyhow!("SSH_PASSWORD_REQUIRED"))?;
            serde_json::from_slice::<Credential>(&bytes)
                .map_err(|_| anyhow::anyhow!("SSH_CREDENTIAL_FAILED"))?
        } else {
            self.temporary
                .lock()
                .map_err(|_| anyhow::anyhow!("SSH_AUTH_FAILED"))?
                .get(id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("SSH_PASSWORD_REQUIRED"))?
        };
        if value.target != target {
            bail!("SSH_CREDENTIAL_TARGET_CHANGED");
        }
        Ok(value)
    }
    pub async fn prepare(
        &self,
        connection: &SshTarget,
        credentials: Arc<dyn Credentials>,
        confirm: impl Fn(&str) -> bool + Send + 'static,
    ) -> Result<Prepared> {
        let effective = super::effective_target(connection).await?;
        let mut prepared = Prepared {
            effective,
            askpass: None,
            #[cfg(test)]
            configuration: None,
        };
        if connection.authentication.as_deref() != Some("password") {
            return Ok(prepared);
        }
        // A jump command could ask for a different server's password in the same environment. 跳板命令可能在同一环境中请求其他服务器密码。
        if prepared.effective.proxy {
            bail!("SSH_PASSWORD_PROXY_UNSUPPORTED");
        }
        let value = self
            .load(
                credentials,
                connection,
                &target(connection, &prepared.effective),
            )
            .await?;
        let expected = format!(
            "{}@{}'s password:",
            prepared.effective.user, prepared.effective.password_host
        );
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| anyhow::anyhow!("SSH_AUTH_FAILED"))?;
        pending.retain(|server| !server.finished());
        if pending.len() >= 32 {
            bail!("SSH_AUTH_BUSY");
        }
        let server = Server::new(value.password, expected, confirm)?;
        prepared.askpass = Some(server.endpoint.clone());
        pending.push(server);
        Ok(prepared)
    }
    pub async fn configure(
        &self,
        credentials: Arc<dyn Credentials>,
        connection: SshTarget,
        password: Option<String>,
        remember: bool,
    ) -> Result<Option<String>> {
        connection.validate()?;
        if connection.authentication.as_deref() != Some("password") {
            return Ok(None);
        }
        let effective = super::effective_target(&connection).await?;
        if effective.proxy {
            bail!("SSH_PASSWORD_PROXY_UNSUPPORTED");
        }
        let target = target(&connection, &effective);
        let password = if let Some(password) = password {
            password
        } else {
            let previous = self.load(credentials.clone(), &connection, &target).await?;
            if connection.remember_password.unwrap_or(false) == remember {
                return Ok(connection.credential_id);
            }
            previous.password
        };
        if password.is_empty() || password.len() > 1023 || password.contains(['\0', '\r', '\n']) {
            bail!("SSH_PASSWORD_INVALID");
        }
        let credential = Credential { target, password };
        let reference = uuid::Uuid::new_v4().to_string();
        if remember {
            let id = reference.clone();
            let bytes = serde_json::to_vec(&credential)?;
            tokio::task::spawn_blocking(move || credentials.access(&id, Some(Some(bytes))))
                .await?
                .map_err(|_| anyhow::anyhow!("SSH_CREDENTIAL_FAILED"))?;
        } else {
            let mut values = self
                .temporary
                .lock()
                .map_err(|_| anyhow::anyhow!("SSH_AUTH_FAILED"))?;
            if values.len() >= 64 {
                bail!("SSH_AUTH_BUSY");
            }
            values.insert(reference.clone(), credential);
        }
        Ok(Some(reference))
    }
    pub async fn forget(
        &self,
        credentials: Arc<dyn Credentials>,
        reference: String,
        remember: bool,
    ) -> Result<()> {
        crate::credentials::validate_reference(&reference)
            .map_err(|_| anyhow::anyhow!("SSH_INVALID_CONNECTION"))?;
        if remember {
            let id = reference.clone();
            tokio::task::spawn_blocking(move || credentials.access(&id, Some(None)))
                .await?
                .map_err(|_| anyhow::anyhow!("SSH_CREDENTIAL_FAILED"))?;
        }
        self.temporary
            .lock()
            .map_err(|_| anyhow::anyhow!("SSH_AUTH_FAILED"))?
            .remove(&reference);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_binding_uses_connection_and_resolved_identity_without_passwords() {
        let connection = SshTarget {
            connection_id: "one".into(),
            ..Default::default()
        };
        let effective = super::super::EffectiveSsh {
            forwarding: false,
            identity: "endpoint-one".into(),
            hostname: "host".into(),
            user: "qa".into(),
            port: "22".into(),
            proxy: false,
            password_host: "host".into(),
        };
        let original = target(&connection, &effective);
        let mut other = connection.clone();
        other.connection_id = "two".into();
        assert_ne!(target(&other, &effective), original);
        other = connection.clone();
        other.credential_id = Some(uuid::Uuid::new_v4().to_string());
        other.remember_password = Some(true);
        other.name = "Renamed".into();
        assert_eq!(target(&other, &effective), original);
        let mut changed = effective.clone();
        changed.identity = "endpoint-two".into();
        assert_ne!(target(&connection, &changed), original);
        assert_eq!(original.len(), 64);
    }
}
