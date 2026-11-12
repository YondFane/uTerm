use super::profiles;
use crate::{session_state, store::Snapshot, store::Store, CoreError, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use utermd_local::ssh::SshTarget;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    expected_revision: String,
    connection: SshTarget,
    id: String,
    directory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Revision {
    expected_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Keep {
    expected_revision: String,
    id: String,
}

pub(super) fn keep(store: &Store, params: Value) -> Result<Snapshot> {
    let request: Keep = serde_json::from_value(params)
        .map_err(|_| CoreError::new("INVALID_PARAMS", "Invalid quick SSH save request"))?;
    store.update(&request.expected_revision, |document| {
        for group in document.workspace["groups"].as_array_mut().unwrap() {
            for profile in group["sshConnections"].as_array_mut().unwrap() {
                if profile["id"] == request.id {
                    profile["temporary"] = json!(false);
                    return Ok(());
                }
            }
        }
        Err(CoreError::new(
            "SSH_CONNECTION_MISSING",
            "SSH connection no longer exists",
        ))
    })
}

pub(super) fn prune(
    store: &Store,
    params: Value,
    mut busy: impl FnMut(&str) -> Result<bool>,
) -> Result<Snapshot> {
    let request: Revision = serde_json::from_value(params)
        .map_err(|_| CoreError::new("INVALID_PARAMS", "Invalid quick SSH cleanup request"))?;
    store.update(&request.expected_revision, |document| {
        let candidates: Vec<String> = document.workspace["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|group| group["sshConnections"].as_array().into_iter().flatten())
            .filter(|profile| {
                profile["temporary"] == true
                    && profile["sessions"]
                        .as_array()
                        .is_some_and(|sessions| sessions.is_empty())
            })
            .filter_map(|profile| profile["id"].as_str().map(str::to_owned))
            .collect();
        for id in candidates {
            if busy(&id)? {
                continue;
            }
            match profiles::remove(&mut document.workspace, &id) {
                Ok(()) => {}
                Err(error) if error.code == "SSH_CONNECTION_BUSY" => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    })
}

pub(super) fn create(store: &Store, params: Value) -> Result<Snapshot> {
    let request: Create = serde_json::from_value(params)
        .map_err(|_| CoreError::new("INVALID_PARAMS", "Invalid quick SSH request"))?;
    let connection = request.connection;
    connection
        .validate()
        .map_err(|_| CoreError::new("SSH_INVALID_CONNECTION", "Invalid quick SSH connection"))?;
    let valid_user = connection.username.as_deref().is_none_or(|value| {
        value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
    });
    if connection.authentication.as_deref() != Some("config")
        || connection.os != "posix"
        || !connection.root.is_empty()
        || !matches!(connection.mode.as_deref(), Some("alias" | "direct"))
        || connection.identity_file.is_some()
        || connection.credential_id.is_some()
        || connection.remember_password.is_some()
        || connection.jump_host.is_some()
        || connection.host.contains(['@', '[', ']'])
        || (connection.host.contains(':') && connection.host.parse::<std::net::Ipv6Addr>().is_err())
        || !valid_user
        || request.id.is_empty()
        || request.id.len() > 200
        || connection.connection_id.len() > 200
        || (connection.mode.as_deref() == Some("alias")
            && (connection.port.is_some() || connection.username.is_some()))
        || !Path::new(&request.directory).is_absolute()
        || !Path::new(&request.directory).is_dir()
    {
        return Err(CoreError::new(
            "SSH_INVALID_CONNECTION",
            "Quick SSH requires an address and automatic OpenSSH authentication",
        ));
    }
    store.update(&request.expected_revision, |document| {
        if document.workspace["selectedWorkspace"] != connection.workspace_id {
            return Err(CoreError::new(
                "CONFLICT",
                "The quick SSH workspace changed",
            ));
        }
        if document.workspace["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|group| group["sshConnections"].as_array().into_iter().flatten())
            .any(|profile| profile["id"] == connection.connection_id)
        {
            return Err(CoreError::new(
                "SSH_CONNECTION_EXISTS",
                "Quick SSH cannot replace an existing connection",
            ));
        }
        profiles::save(&mut document.workspace, connection.clone())?;
        let group = document.workspace["groups"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|group| group["id"] == connection.workspace_id)
            .unwrap();
        let profile = group["sshConnections"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|profile| profile["id"] == connection.connection_id)
            .unwrap();
        profile["temporary"] = json!(true);
        session_state::transition(
            &mut document.workspace,
            &document.settings,
            "session.create",
            &json!({"id":request.id,"name":connection.name,"workspaceId":connection.workspace_id,
                "sshConnectionId":connection.connection_id,"directory":request.directory}),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Core, Response};

    fn call(core: &Core, method: &str, params: Value) -> Response {
        core.execute(
            &serde_json::to_vec(
                &json!({"version":1,"id":"quick-ssh","method":method,"params":params}),
            )
            .unwrap(),
        )
    }
    fn snapshot(core: &Core) -> Value {
        call(core, "snapshot.read", Value::Null).result.unwrap()
    }
    fn fixture() -> (tempfile::TempDir, Core) {
        let root = tempfile::tempdir().unwrap();
        let core = Core::open(root.path().join("shared-state-v1")).unwrap();
        let defaults = crate::state::defaults();
        assert!(call(
            &core,
            "migration.import",
            json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}})
        )
        .error
        .is_none());
        (root, core)
    }
    fn params(core: &Core, directory: &Path, profile: &str, session: &str) -> Value {
        json!({"expectedRevision":snapshot(core)["revision"],"id":session,"directory":directory,
            "connection":{"connection_id":profile,"workspace_id":"local","name":"prod","host":"prod",
                "os":"posix","root":"","mode":"alias","authentication":"config"}})
    }

    #[test]
    fn temporary_profile_and_first_session_commit_together_without_starting_a_host_or_ssh_service()
    {
        let (root, core) = fixture();
        for (profile, session, endpoint) in [
            ("quick-alias", "alias-session", None),
            ("quick-ipv6", "ipv6-session", Some("::1")),
        ] {
            let mut request = params(&core, root.path(), profile, session);
            if let Some(host) = endpoint {
                request["connection"]["host"] = json!(host);
                request["connection"]["mode"] = json!("direct");
                request["connection"]["port"] = json!(2222);
                request["connection"]["username"] = json!("dev");
            }
            let response = call(&core, "ssh.quick.create", request);
            assert!(response.error.is_none(), "{:?}", response.error);
            let saved = response.result.unwrap();
            let workspace = &saved["document"]["workspace"];
            assert_eq!(workspace["selectedSession"], session);
            assert_eq!(workspace["selectedProject"], Value::Null);
            let row = workspace["groups"][0]["sshConnections"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == profile)
                .unwrap();
            assert_eq!(row["temporary"], true);
            assert_eq!(row["sessions"].as_array().unwrap().len(), 1);
            assert_eq!(row["sessions"][0]["id"], session);
            assert_eq!(row["sessions"][0]["ssh"]["connection_id"], profile);
            assert_eq!(row["sessions"][0]["directory"], json!(root.path()));
            assert_eq!(snapshot(&core), saved);
        }
        assert_eq!(
            snapshot(&core)["document"]["workspace"]["groups"][0]["sshConnections"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(core.host.get().is_none());
        assert!(core.ssh.lock().unwrap().is_none());
        assert!(!root.path().join("local-daemon-v1").exists());
        core.close();
    }

    #[test]
    fn stale_revision_and_workspace_switch_preserve_all_snapshot_bytes() {
        let (root, core) = fixture();
        let stale = params(&core, root.path(), "quick", "quick-session");
        let old = snapshot(&core);
        assert!(call(
            &core,
            "settings.patch",
            json!({"expectedRevision":old["revision"],"patch":{"fontSize":18}})
        )
        .error
        .is_none());
        let before = snapshot(&core);
        let bytes = std::fs::read(root.path().join("shared-state-v1/snapshot-v1.json")).unwrap();
        assert_eq!(
            call(&core, "ssh.quick.create", stale).error.unwrap().code,
            "CONFLICT"
        );
        assert_eq!(
            std::fs::read(root.path().join("shared-state-v1/snapshot-v1.json")).unwrap(),
            bytes
        );
        assert_eq!(snapshot(&core), before);
        assert!(call(
            &core,
            "workspace.create",
            json!({"expectedRevision":before["revision"],"id":"other","name":"Other","select":true})
        )
        .error
        .is_none());
        let wrong_workspace = params(&core, root.path(), "quick", "quick-session");
        let before = snapshot(&core);
        assert_eq!(
            call(&core, "ssh.quick.create", wrong_workspace)
                .error
                .unwrap()
                .code,
            "CONFLICT"
        );
        assert_eq!(snapshot(&core), before);
        core.close();
    }

    #[test]
    fn duplicate_profile_or_session_rolls_back_the_complete_quick_creation() {
        let (root, core) = fixture();
        assert!(call(
            &core,
            "ssh.quick.create",
            params(&core, root.path(), "quick", "original")
        )
        .error
        .is_none());
        for (profile, session) in [("quick", "new"), ("new-profile", "original")] {
            let before = snapshot(&core);
            let bytes =
                std::fs::read(root.path().join("shared-state-v1/snapshot-v1.json")).unwrap();
            assert!(call(
                &core,
                "ssh.quick.create",
                params(&core, root.path(), profile, session)
            )
            .error
            .is_some());
            assert_eq!(snapshot(&core), before);
            assert_eq!(
                std::fs::read(root.path().join("shared-state-v1/snapshot-v1.json")).unwrap(),
                bytes
            );
        }
        core.close();
    }

    #[test]
    fn private_options_malformed_addresses_and_unknown_fields_never_mutate_or_echo_values() {
        let (root, core) = fixture();
        let before = snapshot(&core);
        for (key, value) in [
            ("host", json!("-oProxyCommand=bad")),
            ("host", json!("a@b")),
            ("host", json!("[::1]")),
            ("host", json!("::bad::host")),
            ("username", json!("-dev")),
            ("port", json!(22)),
            ("authentication", json!("password")),
            ("identity_file", json!("DONT_ECHO_SECRET")),
            ("credential_id", json!("DONT_ECHO_SECRET")),
            ("private_key_contents", json!("DONT_ECHO_SECRET")),
            ("password", json!("DONT_ECHO_SECRET")),
            ("root", json!("DONT_ECHO_SECRET")),
            ("os", json!("windows")),
        ] {
            let mut request = params(&core, root.path(), "quick", "new-session");
            request["connection"][key] = value;
            let response = call(&core, "ssh.quick.create", request);
            assert!(response.error.is_some(), "{key}");
            assert!(!serde_json::to_string(&response)
                .unwrap()
                .contains("DONT_ECHO_SECRET"));
            assert_eq!(snapshot(&core), before);
        }
        let mut request = params(&core, root.path(), "quick", "new-session");
        request["directory"] = json!("relative-directory");
        assert!(call(&core, "ssh.quick.create", request).error.is_some());
        assert_eq!(snapshot(&core), before);
        assert!(core.ssh.lock().unwrap().is_none());
        core.close();
    }

    #[test]
    fn cleanup_retains_saved_sessions_dependencies_and_simulated_transport_ownership() {
        let (root, core) = fixture();
        for id in ["saved", "live", "idle", "held", "dependency"] {
            assert!(call(
                &core,
                "ssh.quick.create",
                params(&core, root.path(), id, &format!("session-{id}"))
            )
            .error
            .is_none());
        }
        let saved = call(
            &core,
            "ssh.quick.keep",
            json!({"expectedRevision":snapshot(&core)["revision"],"id":"saved"}),
        );
        assert!(saved.error.is_none());
        assert!(core.ssh.lock().unwrap().is_none());
        for id in ["saved", "idle", "held", "dependency"] {
            assert!(call(
                &core,
                "session.remove",
                json!({"expectedRevision":snapshot(&core)["revision"],"id":format!("session-{id}")})
            )
            .error
            .is_none());
        }
        let before_dependency = snapshot(&core);
        let mut workspace = before_dependency["document"]["workspace"].clone();
        workspace["groups"][0]["redisConnections"] = json!([{"id":uuid::Uuid::new_v4().to_string(),"name":"Dependent Redis","host":"localhost","port":6379,"db":0,"username":"","tls":false,"ca_file":"","server_name":"","ssh_host":"prod","credential_id":null}]);
        assert!(call(&core, "snapshot.replace", json!({"expectedRevision":before_dependency["revision"],"workspace":workspace,"settings":before_dependency["document"]["settings"]})).error.is_none());
        let cleaned = prune(
            &core.store,
            json!({"expectedRevision":snapshot(&core)["revision"]}),
            |id| Ok(id == "held"),
        )
        .unwrap();
        // The legacy host dependency applies to every matching alias and must retain them all.
        // 旧式主机依赖适用于所有同名别名，因此必须保留这些连接。
        assert_eq!(
            cleaned.document.workspace["groups"][0]["sshConnections"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
        let mut workspace = cleaned.document.workspace.clone();
        workspace["groups"][0]["redisConnections"] = json!([]);
        assert!(call(&core, "snapshot.replace", json!({"expectedRevision":cleaned.revision,"workspace":workspace,"settings":cleaned.document.settings})).error.is_none());
        let cleaned = prune(
            &core.store,
            json!({"expectedRevision":snapshot(&core)["revision"]}),
            |id| Ok(id == "held"),
        )
        .unwrap();
        let ids: Vec<_> = cleaned.document.workspace["groups"][0]["sshConnections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|profile| profile["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["saved", "live", "held"]);
        let response = call(
            &core,
            "ssh.quick.prune",
            json!({"expectedRevision":cleaned.revision}),
        );
        assert!(response.error.is_none(), "{:?}", response.error);
        let cleaned = response.result.unwrap();
        let profiles = cleaned["document"]["workspace"]["groups"][0]["sshConnections"]
            .as_array()
            .unwrap();
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0]["id"], "saved");
        assert_eq!(profiles[0]["temporary"], false);
        assert_eq!(profiles[1]["id"], "live");
        core.close();
    }

    #[test]
    fn keep_and_cleanup_reject_stale_revisions_and_unknown_fields_without_changing_bytes() {
        let (root, core) = fixture();
        assert!(call(
            &core,
            "ssh.quick.create",
            params(&core, root.path(), "quick", "session")
        )
        .error
        .is_none());
        let old = snapshot(&core);
        assert!(call(
            &core,
            "settings.patch",
            json!({"expectedRevision":old["revision"],"patch":{"fontSize":18}})
        )
        .error
        .is_none());
        let before = snapshot(&core);
        for method in ["ssh.quick.keep", "ssh.quick.prune"] {
            let params = if method.ends_with("keep") {
                json!({"expectedRevision":old["revision"],"id":"quick"})
            } else {
                json!({"expectedRevision":old["revision"]})
            };
            assert_eq!(call(&core, method, params).error.unwrap().code, "CONFLICT");
            assert_eq!(snapshot(&core), before);
            let params = if method.ends_with("keep") {
                json!({"expectedRevision":before["revision"],"id":"quick","private_key_contents":"DONT_ECHO_SECRET"})
            } else {
                json!({"expectedRevision":before["revision"],"private_key_contents":"DONT_ECHO_SECRET"})
            };
            let response = call(&core, method, params);
            assert_eq!(response.error.as_ref().unwrap().code, "INVALID_PARAMS");
            assert!(!serde_json::to_string(&response)
                .unwrap()
                .contains("DONT_ECHO_SECRET"));
            assert_eq!(snapshot(&core), before);
        }
        core.close();
    }
}
