use super::{
    service::{Request, Service},
    Host,
};
use crate::{service_json, Core, CoreError, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

fn failure(error: impl std::fmt::Display) -> CoreError {
    let code = error.to_string();
    if code.starts_with("DB_") && code.bytes().all(|v| v.is_ascii_uppercase() || v == b'_') {
        CoreError::new(&code, &code)
    } else {
        CoreError::new("DB_OPERATION_FAILED", "Database operation failed")
    }
}
impl Core {
    fn database_service(&self, identifier: Option<String>) -> Result<Arc<Service>> {
        let mut current = self.database.lock().map_err(|_| failure("DB_CLOSED"))?;
        if let Some(service) = &*current {
            if identifier
                .as_ref()
                .is_some_and(|v| *v != service.identifier)
            {
                return Err(failure("DB_ALREADY_CONFIGURED"));
            }
            return Ok(service.clone());
        }
        let identifier = identifier.unwrap_or_else(|| {
            format!(
                "sh.uterm.core.{:x}",
                Sha256::digest(self.store.root().to_string_lossy().as_bytes())
            )
        });
        if identifier.is_empty()
            || identifier.len() > 200
            || !identifier
                .bytes()
                .all(|v| v.is_ascii_alphanumeric() || v == b'.' || v == b'-')
        {
            return Err(failure("DB_INVALID_CONFIG"));
        }
        let configured = self.ssh.lock().map_err(|_| failure("DB_CLOSED"))?.is_some();
        let ssh = self.ssh_service((!configured).then(|| format!("{identifier}.ssh")))?;
        let data = self.data_root()?.to_path_buf();
        let service = Arc::new(
            Service::new(Host {
                database: Default::default(),
                components: Default::default(),
                cache: data.join("cache"),
                data,
                identifier,
                prepare_ssh: Arc::new(move |target| {
                    let ssh = ssh.clone();
                    Box::pin(async move {
                        tokio::task::spawn_blocking(move || ssh.prepare(target)).await?
                    })
                }),
                pick_file: Arc::new(|| Box::pin(async { anyhow::bail!("DB_PICKER_REQUIRED") })),
                events: Arc::new(|_, _| Ok(())),
            })
            .map_err(failure)?,
        );
        *current = Some(service.clone());
        Ok(service)
    }
    pub(crate) fn database_request(&self, method: &str, params: Value) -> Result<Value> {
        if method == "database.configure" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Configure {
                identifier: String,
            }
            let request: Configure =
                serde_json::from_value(params).map_err(|_| failure("DB_INVALID_CONFIG"))?;
            let service = self.database_service(Some(request.identifier))?;
            return Ok(json!({"configured":true,"identifier":service.identifier}));
        }
        let service = self.database_service(None)?;
        if method == "database.profile.save" || method == "database.profile.remove" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Profile {
                expected_revision: String,
                workspace_id: String,
                config: Option<super::Config>,
                id: Option<String>,
            }
            let request: Profile =
                serde_json::from_value(params).map_err(|_| failure("DB_INVALID_REQUEST"))?;
            let id = if method == "database.profile.save" {
                if request.id.is_some() {
                    return Err(failure("DB_INVALID_REQUEST"));
                }
                let config = request
                    .config
                    .as_ref()
                    .ok_or_else(|| failure("DB_INVALID_CONFIG"))?;
                config
                    .validate()
                    .map_err(|_| failure("DB_INVALID_CONFIG"))?;
                config.id.clone()
            } else {
                if request.config.is_some() {
                    return Err(failure("DB_INVALID_REQUEST"));
                }
                request
                    .id
                    .clone()
                    .ok_or_else(|| failure("DB_INVALID_REQUEST"))?
            };
            return service.with_profile_change(&id, || {
                let saved = self.store.update(&request.expected_revision, |document| {
                    let groups = document.workspace["groups"]
                        .as_array_mut()
                        .ok_or_else(|| failure("DB_INVALID_CONFIG"))?;
                    let group = groups
                        .iter_mut()
                        .find(|group| group["id"] == request.workspace_id)
                        .ok_or_else(|| failure("DB_INVALID_CONFIG"))?;
                    let profiles = group
                        .as_object_mut()
                        .ok_or_else(|| failure("DB_INVALID_CONFIG"))?
                        .entry("databaseConnections")
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                        .ok_or_else(|| failure("DB_INVALID_CONFIG"))?;
                    if let Some(config) = &request.config {
                        let profile = serde_json::to_value(config)?;
                        if let Some(existing) =
                            profiles.iter_mut().find(|profile| profile["id"] == id)
                        {
                            *existing = profile;
                        } else {
                            profiles.push(profile);
                        }
                    } else {
                        if !profiles.iter().any(|profile| profile["id"] == id) {
                            return Err(failure("DB_INVALID_CONFIG"));
                        }
                        profiles.retain(|profile| profile["id"] != id);
                    }
                    crate::state::validate_workspace(&document.workspace)
                })?;
                service_json(saved)
            });
        }
        if [
            "database.operations",
            "database.events",
            "database.status",
            "database.resume",
        ]
        .contains(&method)
            && !params.is_null()
            && params.as_object().is_none_or(|value| !value.is_empty())
        {
            return Err(failure("DB_INVALID_REQUEST"));
        }
        match method {
            "database.operation.start" => {
                let request: Request =
                    serde_json::from_value(params).map_err(|_| failure("DB_INVALID_REQUEST"))?;
                service_json(service.start(request).map_err(failure)?)
            }
            "database.operations" => service_json(service.operations().map_err(failure)?),
            "database.operation.read" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Read {
                    id: String,
                    generation: String,
                    consume: bool,
                }
                let request: Read =
                    serde_json::from_value(params).map_err(|_| failure("DB_INVALID_REQUEST"))?;
                service_json(
                    service
                        .read(&request.id, &request.generation, request.consume)
                        .map_err(failure)?,
                )
            }
            "database.resume" => {
                service.resume().map_err(failure)?;
                Ok(Value::Null)
            }
            "database.events" => service_json(service.events().map_err(failure)?),
            "database.status" => service.status().map_err(failure),
            _ => Err(CoreError::new(
                "METHOD_NOT_FOUND",
                "Unknown database method",
            )),
        }
    }
}
