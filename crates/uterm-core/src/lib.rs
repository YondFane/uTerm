mod connections;
pub mod state;
pub mod store;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

pub const CONTRACT_VERSION: u32 = 1;
pub const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct CoreError {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}
impl CoreError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            recoverable: true,
        }
    }
}
impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for CoreError {}
impl From<std::io::Error> for CoreError {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO", error.to_string())
    }
}
impl From<serde_json::Error> for CoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("INVALID_JSON", error.to_string())
    }
}
pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Response {
    pub version: u32,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CoreError>,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub version: u32,
    pub operation_id: String,
    pub kind: String,
    pub revision: String,
}

pub struct Core {
    store: store::Store,
}
impl Core {
    pub fn open(root: PathBuf) -> Result<Self> {
        Ok(Self {
            store: store::Store::open(root)?,
        })
    }
    pub fn execute(&self, bytes: &[u8]) -> Response {
        let mut id = String::new();
        let outcome = (|| {
            if bytes.len() > MAX_REQUEST_BYTES {
                return Err(CoreError::new(
                    "REQUEST_TOO_LARGE",
                    "Request exceeds the bounded control limit",
                ));
            }
            let request: Request = serde_json::from_slice(bytes)?;
            id.clone_from(&request.id);
            if request.version != CONTRACT_VERSION {
                return Err(CoreError::new(
                    "UNSUPPORTED_VERSION",
                    "Unsupported control contract version",
                ));
            }
            if id.is_empty() || id.len() > 128 {
                return Err(CoreError::new("INVALID_OPERATION", "Invalid operation ID"));
            }
            self.dispatch(&request.method, request.params)
        })();
        match outcome {
            Ok(value) => Response {
                version: CONTRACT_VERSION,
                id,
                result: Some(value),
                error: None,
            },
            Err(error) => Response {
                version: CONTRACT_VERSION,
                id,
                result: None,
                error: Some(error),
            },
        }
    }
    fn dispatch(&self, method: &str, params: Value) -> Result<Value> {
        match method {
            "contract.info" => Ok(
                json!({"version":CONTRACT_VERSION,"storageSchema":1,"terminalEncoding":"binary","maximumRequestBytes":MAX_REQUEST_BYTES}),
            ),
            "state.defaults" => Ok(state::defaults()),
            "snapshot.read" => serde_json::to_value(self.store.read()?).map_err(Into::into),
            "recovery.list" => self.store.recovery_list(),
            "recovery.restore" => serde_json::to_value(self.store.recover(
                &string(&params, "expectedRevision")?,
                &string(&params, "backupRevision")?,
            )?)
            .map_err(Into::into),
            "migration.import" => {
                let input: store::Import = serde_json::from_value(params)?;
                serde_json::to_value(self.store.import(input)?).map_err(Into::into)
            }
            "legacy.export" => {
                let snapshot = self.store.read()?;
                let mut legacy = snapshot.document.legacy;
                legacy.insert(
                    "uterm.desktop.workspace.v1".into(),
                    serde_json::to_string(&snapshot.document.workspace)?,
                );
                legacy.insert(
                    "uterm.desktop.settings.v1".into(),
                    serde_json::to_string(&snapshot.document.settings)?,
                );
                Ok(json!({"revision":snapshot.revision,"values":legacy}))
            }
            "snapshot.replace" => {
                let revision = string(&params, "expectedRevision")?;
                self.store
                    .update(&revision, |document| {
                        let workspace = params
                            .get("workspace")
                            .ok_or_else(|| {
                                CoreError::new("INVALID_WORKSPACE", "Workspace is required")
                            })?
                            .clone();
                        let settings = params
                            .get("settings")
                            .ok_or_else(|| {
                                CoreError::new("INVALID_SETTINGS", "Settings are required")
                            })?
                            .clone();
                        state::validate_workspace(&workspace)?;
                        state::validate_settings(&settings)?;
                        document.workspace = workspace;
                        document.settings = settings;
                        Ok(())
                    })
                    .and_then(|snapshot| serde_json::to_value(snapshot).map_err(Into::into))
            }
            method
                if method.starts_with("workspace.")
                    || method.starts_with("project.")
                    || method == "selection.set" =>
            {
                let revision = string(&params, "expectedRevision")?;
                self.store
                    .update(&revision, |document| {
                        state::transition(&mut document.workspace, method, &params)
                    })
                    .and_then(|snapshot| serde_json::to_value(snapshot).map_err(Into::into))
            }
            "settings.patch" => {
                let revision = string(&params, "expectedRevision")?;
                self.store
                    .update(&revision, |document| {
                        let patch =
                            params
                                .get("patch")
                                .and_then(Value::as_object)
                                .ok_or_else(|| {
                                    CoreError::new(
                                        "INVALID_SETTINGS",
                                        "Settings patch must be an object",
                                    )
                                })?;
                        let settings = document.settings.as_object_mut().ok_or_else(|| {
                            CoreError::new("CORRUPT_STORE", "Saved settings are not an object")
                        })?;
                        for (key, value) in patch {
                            settings.insert(key.clone(), value.clone());
                        }
                        state::validate_settings(&document.settings)
                    })
                    .and_then(|snapshot| serde_json::to_value(snapshot).map_err(Into::into))
            }
            _ => Err(CoreError::new(
                "UNKNOWN_METHOD",
                format!("Unknown operation: {method}"),
            )),
        }
    }
}
pub(crate) fn string(value: &Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| CoreError::new("INVALID_ARGUMENT", format!("Missing string: {key}")))
}
