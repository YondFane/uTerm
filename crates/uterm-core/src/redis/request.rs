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
    if code.starts_with("REDIS_") && code.bytes().all(|v| v.is_ascii_uppercase() || v == b'_') {
        CoreError::new(&code, &code)
    } else {
        CoreError::new("REDIS_OPERATION_FAILED", "Redis operation failed")
    }
}
impl Core {
    fn redis_service(&self, identifier: Option<String>) -> Result<Arc<Service>> {
        let mut current = self.redis.lock().map_err(|_| failure("REDIS_CLOSED"))?;
        if let Some(service) = &*current {
            if identifier
                .as_ref()
                .is_some_and(|v| *v != service.identifier)
            {
                return Err(failure("REDIS_ALREADY_CONFIGURED"));
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
            return Err(failure("REDIS_INVALID_CONFIG"));
        }
        let configured = self
            .ssh
            .lock()
            .map_err(|_| failure("REDIS_CLOSED"))?
            .is_some();
        let ssh = self.ssh_service((!configured).then(|| format!("{identifier}.ssh")))?;
        let service = Arc::new(
            Service::new(Host {
                state: Default::default(),
                identifier,
                prepare_ssh: Arc::new(move |target| {
                    let ssh = ssh.clone();
                    Box::pin(async move {
                        tokio::task::spawn_blocking(move || ssh.prepare(target)).await?
                    })
                }),
            })
            .map_err(failure)?,
        );
        *current = Some(service.clone());
        Ok(service)
    }
    pub(crate) fn redis_request(&self, method: &str, params: Value) -> Result<Value> {
        if method == "redis.configure" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Configure {
                identifier: String,
            }
            let request: Configure =
                serde_json::from_value(params).map_err(|_| failure("REDIS_INVALID_CONFIG"))?;
            let service = self.redis_service(Some(request.identifier))?;
            return Ok(json!({"configured":true,"identifier":service.identifier}));
        }
        let service = self.redis_service(None)?;
        if method == "redis.profile.save" || method == "redis.profile.remove" {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Profile {
                expected_revision: String,
                workspace_id: String,
                config: Option<super::Config>,
                id: Option<String>,
            }
            let request: Profile =
                serde_json::from_value(params).map_err(|_| failure("REDIS_INVALID_REQUEST"))?;
            let id = if method == "redis.profile.save" {
                if request.id.is_some() {
                    return Err(failure("REDIS_INVALID_REQUEST"));
                }
                let config = request
                    .config
                    .as_ref()
                    .ok_or_else(|| failure("REDIS_INVALID_CONFIG"))?;
                config
                    .validate()
                    .map_err(|_| failure("REDIS_INVALID_CONFIG"))?;
                config.id.clone()
            } else {
                if request.config.is_some() {
                    return Err(failure("REDIS_INVALID_REQUEST"));
                }
                request
                    .id
                    .clone()
                    .ok_or_else(|| failure("REDIS_INVALID_REQUEST"))?
            };
            return service.with_profile_change(&id, || {
                let saved = self.store.update(&request.expected_revision, |document| {
                    let groups = document.workspace["groups"]
                        .as_array_mut()
                        .ok_or_else(|| failure("REDIS_INVALID_CONFIG"))?;
                    let group = groups
                        .iter_mut()
                        .find(|group| group["id"] == request.workspace_id)
                        .ok_or_else(|| failure("REDIS_INVALID_CONFIG"))?;
                    let profiles = group
                        .as_object_mut()
                        .ok_or_else(|| failure("REDIS_INVALID_CONFIG"))?
                        .entry("redisConnections")
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                        .ok_or_else(|| failure("REDIS_INVALID_CONFIG"))?;
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
                            return Err(failure("REDIS_INVALID_CONFIG"));
                        }
                        profiles.retain(|profile| profile["id"] != id);
                    }
                    crate::state::validate_workspace(&document.workspace)
                })?;
                service_json(saved)
            });
        }
        if ["redis.operations", "redis.status", "redis.resume"].contains(&method)
            && !params.is_null()
            && params.as_object().is_none_or(|value| !value.is_empty())
        {
            return Err(failure("REDIS_INVALID_REQUEST"));
        }
        match method {
            "redis.operation.start" => {
                let request: Request =
                    serde_json::from_value(params).map_err(|_| failure("REDIS_INVALID_REQUEST"))?;
                service_json(service.start(request).map_err(failure)?)
            }
            "redis.operations" => service_json(service.operations().map_err(failure)?),
            "redis.operation.read" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Read {
                    id: String,
                    generation: String,
                    consume: bool,
                }
                let request: Read =
                    serde_json::from_value(params).map_err(|_| failure("REDIS_INVALID_REQUEST"))?;
                service_json(
                    service
                        .read(&request.id, &request.generation, request.consume)
                        .map_err(failure)?,
                )
            }
            "redis.resume" => {
                service.resume().map_err(failure)?;
                Ok(Value::Null)
            }
            "redis.status" => service.status().map_err(failure),
            _ => Err(CoreError::new("METHOD_NOT_FOUND", "Unknown redis method")),
        }
    }
}
