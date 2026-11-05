use super::{
    profiles,
    service::{Request, Service},
};
use crate::{service_json, string, Core, CoreError, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

fn failure(error: impl std::fmt::Display) -> CoreError {
    let message = error.to_string();
    let prefix = message.split(':').next().unwrap_or_default();
    let code = if prefix.starts_with("SSH_")
        && prefix.bytes().all(|v| v.is_ascii_uppercase() || v == b'_')
    {
        prefix
    } else {
        "SSH_OPERATION_FAILED"
    };
    CoreError::new(code, &message)
}
impl Core {
    pub(crate) fn ssh_service(&self, namespace: Option<String>) -> Result<Arc<Service>> {
        let mut current = self
            .ssh
            .lock()
            .map_err(|_| CoreError::new("SSH_CLOSED", "SSH service is unavailable"))?;
        if let Some(service) = &*current {
            if namespace.as_ref().is_some_and(|v| *v != service.namespace) {
                return Err(CoreError::new(
                    "SSH_ALREADY_CONFIGURED",
                    "SSH credentials are already scoped to this client",
                ));
            }
            return Ok(service.clone());
        }
        let namespace = namespace.unwrap_or_else(|| {
            format!(
                "sh.uterm.core.{:x}.ssh",
                Sha256::digest(self.store.root().to_string_lossy().as_bytes())
            )
        });
        let service = Arc::new(Service::new(namespace).map_err(failure)?);
        *current = Some(service.clone());
        Ok(service)
    }
    pub(crate) fn ssh_request(&self, method: &str, params: Value) -> Result<Value> {
        if method == "ssh.configure" {
            let service = self.ssh_service(Some(string(&params, "credentialService")?))?;
            return Ok(json!({"configured":true,"credentialService":service.namespace}));
        }
        let service = self.ssh_service(None)?;
        match method {
            "ssh.resume" => {
                service.resume().map_err(failure)?;
                Ok(Value::Null)
            }
            "ssh.operation.start" => {
                let request: Request = serde_json::from_value(params).map_err(|_| {
                    CoreError::new("INVALID_ARGUMENT", "Invalid SSH operation parameters")
                })?;
                service_json(service.start(request).map_err(failure)?)
            }
            "ssh.operations" => service_json(service.operations().map_err(failure)?),
            "ssh.operation.read" => service_json(
                service
                    .read(
                        &string(&params, "id")?,
                        &string(&params, "generation")?,
                        params["consume"].as_bool().unwrap_or(false),
                    )
                    .map_err(failure)?,
            ),
            "ssh.operation.cancel" => {
                service
                    .cancel(&string(&params, "id")?, &string(&params, "generation")?)
                    .map_err(failure)?;
                Ok(Value::Null)
            }
            "ssh.trust.pending" => service_json(service.prompts().map_err(failure)?),
            "ssh.trust.confirm" => {
                let approve = params["approve"].as_bool().ok_or_else(|| {
                    CoreError::new("INVALID_ARGUMENT", "Approval must be a boolean")
                })?;
                service
                    .confirm(&string(&params, "id")?, approve)
                    .map_err(failure)?;
                Ok(Value::Null)
            }
            "ssh.tunnel.start" => service
                .tunnel_start(
                    serde_json::from_value(params["connection"].clone()).map_err(|_| {
                        CoreError::new("INVALID_ARGUMENT", "Invalid SSH connection")
                    })?,
                    serde_json::from_value(params["rule"].clone()).map_err(|_| {
                        CoreError::new("INVALID_ARGUMENT", "Invalid forwarding rule")
                    })?,
                )
                .map_err(failure),
            "ssh.tunnel.list" => service.tunnel_list().map_err(failure),
            "ssh.tunnel.stop" => {
                service
                    .tunnel_stop(
                        string(&params, "connection_id")?,
                        string(&params, "id")?,
                        string(&params, "generation")?,
                    )
                    .map_err(failure)?;
                Ok(Value::Null)
            }
            "ssh.busy" => Ok(json!({"operations":service.busy()})),
            "ssh.profile.save" | "ssh.profile.remove" | "ssh.profile.forwards" => {
                if service.busy() {
                    return Err(CoreError::new(
                        "SSH_OPERATION_BUSY",
                        "Wait for the current SSH operation",
                    ));
                }
                let revision = string(&params, "expectedRevision")?;
                let id = if method == "ssh.profile.save" {
                    string(&params["connection"], "connection_id")?
                } else {
                    string(&params, "id")?
                };
                if method != "ssh.profile.forwards"
                    && service.connection_busy(&id).map_err(failure)?
                {
                    return Err(CoreError::new(
                        "SSH_CONNECTION_BUSY",
                        "Disconnect files and stop its forwarding rules first",
                    ));
                }
                if method == "ssh.profile.forwards" {
                    let snapshot = self.store.read()?;
                    let previous = snapshot.document.workspace["groups"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .flat_map(|g| g["sshConnections"].as_array().into_iter().flatten())
                        .find(|v| v["id"] == id);
                    let statuses = service.tunnel_list().map_err(failure)?;
                    for active in statuses
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|v| v["connection_id"] == id && v["state"] != "error")
                    {
                        let old = previous
                            .and_then(|p| p["forwards"].as_array())
                            .and_then(|rules| rules.iter().find(|r| r["id"] == active["id"]));
                        let new = params["rules"]
                            .as_array()
                            .and_then(|rules| rules.iter().find(|r| r["id"] == active["id"]));
                        if old.is_none() || old != new {
                            return Err(CoreError::new(
                                "SSH_FORWARD_BUSY",
                                "Stop the forwarding rule before changing it",
                            ));
                        }
                    }
                }
                let updated = self.store.update(&revision, |document| match method {
                    "ssh.profile.save" => profiles::save(
                        &mut document.workspace,
                        serde_json::from_value(params["connection"].clone()).map_err(|_| {
                            CoreError::new("SSH_INVALID_CONNECTION", "Invalid SSH connection")
                        })?,
                    ),
                    "ssh.profile.remove" => {
                        profiles::remove(&mut document.workspace, &string(&params, "id")?)
                    }
                    _ => profiles::forwards(
                        &mut document.workspace,
                        &string(&params, "id")?,
                        params["rules"].clone(),
                    ),
                })?;
                service_json(updated)
            }
            "ssh.session.create" => {
                let revision = string(&params, "expectedRevision")?;
                let mut create = params.clone();
                create["directory"] = json!(self.data_root()?.to_string_lossy());
                let snapshot = self.store.update(&revision, |document| {
                    crate::session_state::transition(
                        &mut document.workspace,
                        &document.settings,
                        "session.create",
                        &create,
                    )
                })?;
                self.start_ssh_session(&string(&params, "id")?, &service)?;
                service_json(snapshot)
            }
            "ssh.session.start" => {
                self.start_ssh_session(&string(&params, "id")?, &service)?;
                Ok(Value::Null)
            }
            _ => Err(CoreError::new("UNKNOWN_METHOD", "Unknown SSH operation")),
        }
    }
    fn start_ssh_session(&self, id: &str, service: &Service) -> Result<()> {
        use utermd_local::daemon::{Operation, Reply, SessionSpec};
        let snapshot = self.store.read()?;
        let entry = crate::session_state::entries(&snapshot.document.workspace)
            .into_iter()
            .find(|v| v.session["id"] == id)
            .ok_or_else(|| CoreError::new("SESSION_MISSING", "SSH session no longer exists"))?;
        let target: utermd_local::ssh::SshTarget =
            serde_json::from_value(entry.session["ssh"].clone())
                .map_err(|_| CoreError::new("SSH_INVALID_CONNECTION", "SSH session is required"))?;
        let prepared = service.prepare(target.clone()).map_err(failure)?;
        let client = self.host_client()?;
        client.require_ssh_support().map_err(failure)?;
        client.require_ssh_config_support().map_err(failure)?;
        if target.jump_host.is_some() {
            client.require_ssh_jump_support().map_err(failure)?;
        }
        let spec = SessionSpec {
            id: id.into(),
            directory: entry.directory.into(),
            shell: string(&entry.session, "shell")?,
            agent: None,
            ssh: Some(target),
        };
        match client
            .request(Operation::OpenSshConfigured {
                spec,
                rows: 24,
                cols: 80,
                resolved: prepared.resolved().map_err(failure)?,
                askpass: prepared.askpass,
            })
            .map_err(failure)?
        {
            Reply::Opened { .. } => Ok(()),
            _ => Err(CoreError::new("HOST_REPLY", "SSH session was not opened")),
        }
    }
}
