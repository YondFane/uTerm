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

fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

pub fn import_theme(source: &str, name: &str) -> Result<Value> {
    let invalid = || CoreError::new("THEME_INVALID", "Theme name or colors are invalid");
    if source.encode_utf16().count() > 32000
        || name.encode_utf16().count() > 80
        || name.trim_matches(js_space).is_empty()
    {
        return Err(invalid());
    }
    let name = name.trim_matches(js_space);
    // Preserve JavaScript's context-sensitive final sigma and encodeURIComponent identity.
    // 保留 JavaScript 按上下文处理的词尾 sigma 及 encodeURIComponent 标识语义。
    let cased = regex::Regex::new(r"\p{Cased}").unwrap();
    let ignorable = regex::Regex::new(r"\p{Case_Ignorable}").unwrap();
    let chars: Vec<char> = name.chars().collect();
    let mut lower = String::new();
    for (index, ch) in chars.iter().enumerate() {
        let significant = |c: &&char| !ignorable.is_match(&c.to_string());
        let has_before = chars[..index]
            .iter()
            .rev()
            .find(significant)
            .is_some_and(|c| cased.is_match(&c.to_string()));
        let has_after = chars[index + 1..]
            .iter()
            .find(significant)
            .is_some_and(|c| cased.is_match(&c.to_string()));
        if *ch == 'Σ' && has_before && !has_after {
            lower.push('ς');
        } else {
            lower.extend(ch.to_lowercase());
        }
    }
    let mut id = String::from("custom-");
    for byte in lower.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            id.push(byte as char);
        } else {
            id.push_str(&format!("%{byte:02X}"));
        }
    }
    let mut value = catalog()?["themes"][0].clone();
    value.as_object_mut().unwrap().remove("labels");
    value["id"] = Value::String(id);
    value["name"] = Value::String(name.into());
    let palette = [
        "black",
        "red",
        "green",
        "yellow",
        "blue",
        "magenta",
        "cyan",
        "white",
        "brightBlack",
        "brightRed",
        "brightGreen",
        "brightYellow",
        "brightBlue",
        "brightMagenta",
        "brightCyan",
        "brightWhite",
    ];
    let mut recognized = 0;
    for line in source.split('\n') {
        let Some((key, text)) = line.trim_matches(js_space).split_once('=') else {
            continue;
        };
        let key = key.trim_end_matches(js_space);
        let mut color = text.trim_matches(js_space);
        if color.contains(['\r', '\u{2028}', '\u{2029}']) {
            continue;
        }
        let target = match key {
            "background" => "background",
            "foreground" => "foreground",
            "cursor-color" => "cursor",
            "selection-background" => "selectionBackground",
            "palette" => {
                let (index, text) = color.split_once('=').ok_or_else(invalid)?;
                let index = index.trim_end_matches(js_space);
                if index.is_empty() || !index.bytes().all(|c| c.is_ascii_digit()) {
                    return Err(invalid());
                }
                let digits = index.trim_start_matches('0');
                let index: usize = if digits.is_empty() {
                    0
                } else {
                    digits.parse().map_err(|_| invalid())?
                };
                color = text.trim_start_matches(js_space);
                *palette.get(index).ok_or_else(invalid)?
            }
            _ => continue,
        };
        let hex = color.strip_prefix('#').unwrap_or(color);
        if hex.len() != 6 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(invalid());
        }
        value[target] = Value::String(format!("#{hex}"));
        recognized += 1;
    }
    if recognized == 0 {
        return Err(invalid());
    }
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
