use crate::{state, CoreError, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
}

pub fn catalog() -> Result<Value> {
    let mut value: Value = serde_json::from_str(include_str!(
        "../../../shared/contracts/settings-ui-v1.json"
    ))
    .map_err(|_| CoreError::new("SETTINGS_CATALOG", "Settings catalog is unavailable"))?;
    value["defaults"] = state::defaults()["settings"].clone();
    Ok(value)
}

pub fn validate(value: &Value, platform: Platform) -> Result<()> {
    state::validate_settings(value)?;
    let catalog = catalog()?;
    let shortcuts = value["shortcuts"].as_object().unwrap();
    let mut used = HashMap::new();
    for command in catalog["commands"].as_array().unwrap() {
        let id = command["id"].as_str().unwrap();
        let fallback = match (platform, id) {
            (Platform::Windows, "terminalSearch") => "Mod+Shift+KeyF",
            (Platform::Windows, "search") => "Mod+Alt+KeyF",
            _ => command["defaultShortcut"].as_str().unwrap(),
        };
        // Match the existing optional defaults when another command claims their shortcut.
        // 其他命令占用快捷键时，沿用现有可让出的默认绑定规则。
        let key = if let Some(key) = shortcuts.get(id) {
            key.as_str().unwrap()
        } else if [
            "fontDecrease",
            "fontIncrease",
            "nextWorkspace",
            "previousWorkspace",
        ]
        .contains(&id)
            && shortcuts
                .iter()
                .any(|(other, key)| other != id && key == fallback)
        {
            ""
        } else {
            fallback
        };
        if key.is_empty() {
            continue;
        }
        if [
            "Mod+KeyC",
            "Mod+KeyV",
            "Mod+KeyX",
            "Mod+KeyA",
            "Mod+KeyZ",
            "Mod+Shift+KeyZ",
            "Mod+KeyS",
            "Mod+KeyQ",
            "Mod+KeyH",
        ]
        .contains(&key)
        {
            return Err(CoreError::new(
                "SHORTCUT_RESERVED",
                "This shortcut belongs to the system or editor",
            ));
        }
        if used.insert(key.to_owned(), id).is_some() {
            return Err(CoreError::new(
                "SHORTCUT_CONFLICT",
                "Two commands use the same shortcut",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn platform_bindings_keep_defaults_reserved_keys_and_optional_fallbacks() {
        for platform in [Platform::Macos, Platform::Windows] {
            let mut settings = state::defaults()["settings"].clone();
            validate(&settings, platform).unwrap();
            settings["shortcuts"] = json!({"palette":"Mod+KeyQ"});
            assert_eq!(
                validate(&settings, platform).unwrap_err().code,
                "SHORTCUT_RESERVED"
            );
            settings["shortcuts"] = json!({"palette":"Mod+Minus"});
            validate(&settings, platform).unwrap();
            settings["shortcuts"] = json!({"palette":"Mod+Minus","fontDecrease":"Mod+Minus"});
            assert_eq!(
                validate(&settings, platform).unwrap_err().code,
                "SHORTCUT_CONFLICT"
            );
            settings["shortcuts"] = json!({"palette":"Mod+Shift+KeyF"});
            assert_eq!(
                validate(&settings, platform).unwrap_err().code,
                "SHORTCUT_CONFLICT"
            );
        }
        let mut settings = state::defaults()["settings"].clone();
        settings["shortcuts"] = json!({"palette":"Mod+Alt+KeyF"});
        validate(&settings, Platform::Macos).unwrap();
        assert_eq!(
            validate(&settings, Platform::Windows).unwrap_err().code,
            "SHORTCUT_CONFLICT"
        );
    }
}
