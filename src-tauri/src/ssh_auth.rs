use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
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
pub(crate) struct Prepared {
    pub effective: crate::ssh::EffectiveSsh,
    pub askpass: Option<Endpoint>,
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
        if let Some(endpoint) = &self.askpass {
            command.envs(endpoint.environment()?);
            command.args(["-o", "ProxyCommand=none", "-o", "ProxyJump=none"]);
        }
        Ok(())
    }
}
fn service(app: &tauri::AppHandle) -> String {
    format!("{}.ssh", app.config().identifier)
}
fn target(connection: &SshTarget, effective: &crate::ssh::EffectiveSsh) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{}\n{}", connection.connection_id, effective.identity).as_bytes())
    )
}
async fn load(app: &tauri::AppHandle, connection: &SshTarget, target: &str) -> Result<Credential> {
    let id = connection
        .credential_id
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("SSH_PASSWORD_REQUIRED"))?;
    let value = if connection.remember_password == Some(true) {
        let service = service(app);
        let reference = id.clone();
        let bytes = tokio::task::spawn_blocking(move || {
            crate::redis_credentials::access(&service, &reference, None)
        })
        .await?
        .map_err(|_| anyhow::anyhow!("SSH_CREDENTIAL_FAILED"))?
        .ok_or_else(|| anyhow::anyhow!("SSH_PASSWORD_REQUIRED"))?;
        serde_json::from_slice::<Credential>(&bytes)?
    } else {
        app.state::<SshAuth>()
            .temporary
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
pub(crate) async fn prepare(app: &tauri::AppHandle, connection: &SshTarget) -> Result<Prepared> {
    let effective = crate::ssh::effective_target(connection).await?;
    let mut prepared = Prepared {
        effective,
        askpass: None,
    };
    if connection.authentication.as_deref() != Some("password") {
        return Ok(prepared);
    }
    // A jump command could ask for a different server's password in the same environment. 跳板命令可能在同一环境中请求其他服务器密码。
    if prepared.effective.proxy {
        bail!("SSH_PASSWORD_PROXY_UNSUPPORTED");
    }
    let value = load(app, connection, &target(connection, &prepared.effective)).await?;
    let handle = app.clone();
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| anyhow::anyhow!("SSH_AUTH_FAILED"))?;
    let expected = format!(
        "{}@{}'s password:",
        prepared.effective.user, prepared.effective.password_host
    );
    let state = app.state::<SshAuth>();
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| anyhow::anyhow!("SSH_AUTH_FAILED"))?;
    pending.retain(|server| !server.finished());
    if pending.len() >= 32 {
        bail!("SSH_AUTH_BUSY");
    }
    let server = Server::new(value.password, expected, move |prompt| {
        handle
            .dialog()
            .message(prompt)
            .parent(&window)
            .title("SSH 主机指纹 / SSH host fingerprint")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "信任并连接 / Trust and connect".into(),
                "取消 / Cancel".into(),
            ))
            .blocking_show()
    })?;
    prepared.askpass = Some(server.endpoint.clone());
    pending.push(server);
    Ok(prepared)
}
#[tauri::command]
pub async fn ssh_configure_auth(
    app: tauri::AppHandle,
    connection: SshTarget,
    password: Option<String>,
    remember: bool,
) -> Result<Option<String>, String> {
    async {
        connection.validate()?;
        if connection.authentication.as_deref() != Some("password") {
            return Ok(None);
        }
        let effective = crate::ssh::effective_target(&connection).await?;
        if effective.proxy {
            bail!("SSH_PASSWORD_PROXY_UNSUPPORTED");
        }
        let target = target(&connection, &effective);
        let password = if let Some(password) = password {
            password
        } else {
            let previous = load(&app, &connection, &target).await?;
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
            let service = service(&app);
            let id = reference.clone();
            let bytes = serde_json::to_vec(&credential)?;
            tokio::task::spawn_blocking(move || {
                crate::redis_credentials::access(&service, &id, Some(Some(bytes)))
            })
            .await?
            .map_err(|_| anyhow::anyhow!("SSH_CREDENTIAL_FAILED"))?;
        } else {
            let state = app.state::<SshAuth>();
            let mut values = state
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
    .await
    .map_err(|error: anyhow::Error| error.to_string())
}
#[tauri::command]
pub async fn ssh_forget_auth(
    app: tauri::AppHandle,
    reference: String,
    remember: bool,
) -> Result<(), String> {
    crate::redis_credentials::validate_reference(&reference)
        .map_err(|_| "SSH_INVALID_CONNECTION")?;
    if remember {
        let service = service(&app);
        let id = reference.clone();
        tokio::task::spawn_blocking(move || {
            crate::redis_credentials::access(&service, &id, Some(None))
        })
        .await
        .map_err(|_| "SSH_CREDENTIAL_FAILED")?
        .map_err(|_| "SSH_CREDENTIAL_FAILED")?;
    }
    app.state::<SshAuth>()
        .temporary
        .lock()
        .map_err(|_| "SSH_AUTH_FAILED")?
        .remove(&reference);
    Ok(())
}
#[tauri::command]
pub async fn ssh_pick_identity(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_file()
            .map(|v| {
                v.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
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
        let effective = crate::ssh::EffectiveSsh {
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
