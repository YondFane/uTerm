use serde_json::Value;

fn matches(pattern: &str, value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        regex::Regex::new(pattern)
            .expect("static pattern")
            .is_match(s)
    })
}
fn clean(value: &Value, limit: usize) -> bool {
    value.as_str().is_some_and(|s| {
        s.encode_utf16().count() <= limit && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    })
}
fn optional(value: &Value, key: &str, valid: impl FnOnce(&Value) -> bool) -> bool {
    value.get(key).is_none_or(valid)
}
fn keys(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
}
fn port(v: &Value) -> bool {
    v.as_u64().is_some_and(|p| (1..=65535).contains(&p))
}
pub fn uuid(value: &Value) -> bool {
    matches(
        r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        value,
    )
}
pub fn host(value: &Value, ssh: bool) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.len() <= 255 && !s.starts_with('-'))
        && matches(
            if ssh {
                r"^[a-zA-Z0-9_.@:\[\]-]+$"
            } else {
                r"^[a-zA-Z0-9_.:-]+$"
            },
            value,
        )
}
fn jump(value: &Value) -> bool {
    let Some(s) = value.as_str() else {
        return false;
    };
    if s.is_empty() {
        return true;
    }
    if s.len() > 512 {
        return false;
    }
    let re=regex::Regex::new(r"^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[0-9a-fA-F:.]+\])(?::([0-9]{1,5}))?$").unwrap();
    let Some(parts) = re.captures(s) else {
        return false;
    };
    if parts.get(1).is_some_and(|p| {
        p.as_str()
            .parse::<u32>()
            .map_or(true, |n| !(1..=65535).contains(&n))
    }) {
        return false;
    }
    if let Some(start) = s.find('[') {
        let end = s.find(']').unwrap();
        if s[start + 1..end].parse::<std::net::Ipv6Addr>().is_err() {
            return false;
        }
    }
    true
}
const SSH_KEYS: &[&str] = &[
    "mode",
    "port",
    "username",
    "authentication",
    "identity_file",
    "credential_id",
    "remember_password",
    "jump_host",
];
fn ssh_options(v: &Value) -> bool {
    optional(v, "mode", |v| {
        matches!(v.as_str(), Some("alias" | "direct"))
    }) && optional(v, "port", port)
        && optional(v, "username", |v| {
            clean(v, 512) && v.as_str().is_some_and(|s| s.trim() == s)
        })
        && optional(v, "identity_file", |v| clean(v, 4096))
        && optional(v, "authentication", |v| {
            matches!(v.as_str(), Some("config" | "key" | "password"))
        })
        && optional(v, "credential_id", |v| v.is_null() || uuid(v))
        && optional(v, "remember_password", Value::is_boolean)
        && optional(v, "jump_host", jump)
        && !(v["authentication"] == "password"
            && v["jump_host"].as_str().is_some_and(|s| !s.is_empty()))
        && (v["mode"] != "direct"
            || v["host"].as_str().is_some_and(|s| !s.contains('@')) && v.get("port").is_some())
}
pub fn ssh(v: &Value, target: bool) -> bool {
    let mut allowed = SSH_KEYS.to_vec();
    allowed.extend_from_slice(if target {
        &[
            "connection_id",
            "workspace_id",
            "name",
            "host",
            "os",
            "root",
        ]
    } else {
        &[
            "id",
            "name",
            "host",
            "os",
            "root",
            "sessions",
            "splitGroups",
            "temporary",
            "forwards",
        ]
    });
    keys(v, &allowed)
        && ssh_options(v)
        && host(&v["host"], true)
        && matches!(v["os"].as_str(), Some("posix" | "windows"))
        && v["name"].as_str().is_some_and(|s| !s.trim().is_empty())
        && v["root"]
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= 4096 && !s.contains(['\0', '\r', '\n']))
        && (!target
            || ["connection_id", "workspace_id"]
                .iter()
                .all(|k| v[*k].as_str().is_some_and(|s| !s.is_empty())))
        && optional(v, "temporary", Value::is_boolean)
        && optional(v, "forwards", |rules| {
            let Some(rules) = rules.as_array().filter(|r| r.len() <= 16) else {
                return false;
            };
            let mut ids = std::collections::HashSet::new();
            let mut ports = std::collections::HashSet::new();
            rules.iter().all(|r| {
                keys(r, &["id", "local_port", "remote_host", "remote_port"])
                    && uuid(&r["id"])
                    && port(&r["local_port"])
                    && port(&r["remote_port"])
                    && host(&r["remote_host"], false)
                    && r["remote_host"].as_str().is_some_and(|s| {
                        !s.contains(':') || s.parse::<std::net::Ipv6Addr>().is_ok()
                    })
                    && ids.insert(r["id"].to_string())
                    && ports.insert(r["local_port"].to_string())
            })
        })
}
pub fn redis(v: &Value) -> bool {
    keys(
        v,
        &[
            "id",
            "name",
            "host",
            "port",
            "db",
            "username",
            "tls",
            "ca_file",
            "server_name",
            "ssh_host",
            "ssh_target",
            "credential_id",
        ],
    ) && uuid(&v["id"])
        && v["name"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 200)
        && host(&v["host"], false)
        && port(&v["port"])
        && v["db"].as_u64().is_some_and(|n| n <= 1024)
        && v["username"]
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= 512)
        && v["tls"].is_boolean()
        && v["ca_file"]
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= 4096 && !s.contains('\0'))
        && (v["server_name"] == "" || host(&v["server_name"], false))
        && (v["ssh_host"] == "" || host(&v["ssh_host"], true))
        && optional(v, "ssh_target", |t| {
            ssh(t, true) && v["ssh_host"] == t["host"]
        })
        && (v["credential_id"].is_null() && v.get("credential_id").is_some()
            || uuid(&v["credential_id"]))
}
pub fn database(v: &Value) -> bool {
    keys(
        v,
        &[
            "id",
            "name",
            "kind",
            "host",
            "port",
            "database",
            "username",
            "tls",
            "ca_file",
            "ssh_target",
            "credential_id",
            "auth_source",
            "auth_mode",
        ],
    ) && uuid(&v["id"])
        && matches!(
            v["kind"].as_str(),
            Some("mysql" | "postgresql" | "oracle" | "elasticsearch" | "mongodb")
        )
        && clean(&v["name"], 200)
        && v["name"].as_str().is_some_and(|s| !s.trim().is_empty())
        && host(&v["host"], false)
        && port(&v["port"])
        && clean(&v["database"], 255)
        && matches(r"^[a-zA-Z0-9_$.-]*$", &v["database"])
        && (v["kind"] != "oracle" || v["database"] != "")
        && clean(&v["username"], 512)
        && optional(v, "auth_source", |s| {
            v["kind"] == "mongodb" && clean(s, 255) && matches(r"^[a-zA-Z0-9_$.-]+$", s)
        })
        && optional(v, "auth_mode", |m| {
            v["kind"] == "elasticsearch" && matches!(m.as_str(), Some("basic" | "api_key"))
        })
        && v["tls"].is_boolean()
        && clean(&v["ca_file"], 4096)
        && optional(v, "ssh_target", |t| ssh(t, true))
        && (v.get("credential_id").is_some() && v["credential_id"].is_null()
            || matches(r"(?i)^[0-9a-f-]{36}$", &v["credential_id"]))
}
