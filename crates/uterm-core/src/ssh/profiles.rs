use crate::{CoreError, Result};
use serde_json::{json, Value};
use utermd_local::ssh::SshTarget;

pub fn target(workspace: &str, profile: &Value) -> Result<SshTarget> {
    let mut value = profile.clone();
    let object = value
        .as_object_mut()
        .ok_or_else(|| CoreError::new("SSH_INVALID_CONNECTION", "Invalid connection"))?;
    let id = object.remove("id").unwrap_or(Value::Null);
    object.insert("connection_id".into(), id);
    object.insert("workspace_id".into(), json!(workspace));
    for key in ["sessions", "splitGroups", "temporary", "forwards"] {
        object.remove(key);
    }
    serde_json::from_value(value)
        .map_err(|_| CoreError::new("SSH_INVALID_CONNECTION", "Invalid connection"))
}
pub fn save(workspace: &mut Value, connection: SshTarget) -> Result<()> {
    connection
        .validate()
        .map_err(|e| CoreError::new("SSH_INVALID_CONNECTION", e.to_string()))?;
    let groups = workspace["groups"]
        .as_array_mut()
        .ok_or_else(|| CoreError::new("INVALID_WORKSPACE", "Missing workspaces"))?;
    let group = groups
        .iter_mut()
        .find(|g| g["id"] == connection.workspace_id)
        .ok_or_else(|| CoreError::new("INVALID_WORKSPACE", "Workspace no longer exists"))?;
    let rows = group["sshConnections"]
        .as_array_mut()
        .ok_or_else(|| CoreError::new("INVALID_WORKSPACE", "Invalid connections"))?;
    let mut value = serde_json::to_value(&connection)?;
    let object = value.as_object_mut().unwrap();
    object.remove("connection_id");
    object.remove("workspace_id");
    object.insert("id".into(), json!(connection.connection_id));
    if let Some(existing) = rows
        .iter_mut()
        .find(|v| v["id"] == connection.connection_id)
    {
        for key in ["sessions", "splitGroups", "forwards", "temporary"] {
            if let Some(retained) = existing.get(key) {
                object.insert(key.into(), retained.clone());
            }
        }
        *existing = value;
    } else {
        object.insert("sessions".into(), json!([]));
        object.insert("splitGroups".into(), json!([]));
        object.insert("forwards".into(), json!([]));
        rows.push(value);
    }
    for group in groups {
        for kind in ["redisConnections", "databaseConnections"] {
            for dependent in group[kind].as_array_mut().into_iter().flatten() {
                if dependent["ssh_target"]["connection_id"] == connection.connection_id {
                    dependent["ssh_target"] = serde_json::to_value(&connection)?;
                    dependent["ssh_host"] = json!(connection.host);
                }
            }
        }
    }
    crate::state::validate_workspace(workspace)
}
pub fn remove(workspace: &mut Value, id: &str) -> Result<()> {
    let mut retained = None;
    for group in workspace["groups"].as_array().into_iter().flatten() {
        for profile in group["sshConnections"].as_array().into_iter().flatten() {
            if profile["id"] == id {
                if !profile["sessions"].as_array().is_some_and(|v| v.is_empty()) {
                    return Err(CoreError::new(
                        "SSH_CONNECTION_BUSY",
                        "Close its SSH sessions first",
                    ));
                }
                retained = Some(profile.clone());
            }
        }
    }
    let Some(profile) = retained else {
        return Ok(());
    };
    for group in workspace["groups"].as_array().into_iter().flatten() {
        for kind in ["redisConnections", "databaseConnections"] {
            if group[kind].as_array().into_iter().flatten().any(|v| {
                v["ssh_target"]["connection_id"] == id
                    || (v["ssh_target"].is_null() && v["ssh_host"] == profile["host"])
            }) {
                return Err(CoreError::new(
                    "SSH_CONNECTION_BUSY",
                    "Remove its data-connection dependencies first",
                ));
            }
        }
    }
    for group in workspace["groups"].as_array_mut().into_iter().flatten() {
        if let Some(rows) = group["sshConnections"].as_array_mut() {
            rows.retain(|v| v["id"] != id);
        }
    }
    crate::state::validate_workspace(workspace)
}
pub fn forwards(workspace: &mut Value, id: &str, rules: Value) -> Result<()> {
    for group in workspace["groups"].as_array_mut().into_iter().flatten() {
        for profile in group["sshConnections"].as_array_mut().into_iter().flatten() {
            if profile["id"] == id {
                profile["forwards"] = rules;
                return crate::state::validate_workspace(workspace);
            }
        }
    }
    Err(CoreError::new(
        "SSH_CONNECTION_MISSING",
        "SSH connection no longer exists",
    ))
}
