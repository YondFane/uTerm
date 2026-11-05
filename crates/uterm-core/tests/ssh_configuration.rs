use serde_json::{json, Value};
use std::process::Command;
use uterm_core::{ssh, Core, Response};

fn call(core: &Core, method: &str, params: Value) -> Response {
    core.execute(
        &serde_json::to_vec(&json!({
            "version":1,"id":"ssh-configuration-qa","method":method,"params":params
        }))
        .unwrap(),
    )
}

#[test]
fn shared_configuration_contract_uses_real_openssh_without_login_or_secret_storage() {
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().join("shared-state-v1")).unwrap();
    let info = call(&core, "ssh.info", Value::Null);
    assert!(info.error.is_none());
    let typed: ssh::Info = serde_json::from_value(info.result.unwrap()).unwrap();
    assert!(typed.available);
    let connection = json!({"connection_id":"qa","workspace_id":"local","name":"QA",
        "host":"127.0.0.1","os":"posix","root":"","mode":"direct","port":2222,"username":"qa-user"});
    let response = call(&core, "ssh.resolve", json!({"connection":connection}));
    assert!(response.error.is_none());
    let typed: ssh::Resolution = serde_json::from_value(response.result.unwrap()).unwrap();
    assert_eq!(typed.hostname, "127.0.0.1");
    assert_eq!(typed.username, "qa-user");
    assert_eq!(typed.port, "2222");
    for field in ["password", "private_key_contents"] {
        let mut value = connection.clone();
        value[field] = json!("DONT_EXPORT_SECRET");
        for params in [json!({"connection":value}), {
            let mut params = json!({"connection":connection});
            params[field] = json!("DONT_EXPORT_SECRET");
            params
        }] {
            let response = call(&core, "ssh.resolve", params);
            assert_eq!(response.error.as_ref().unwrap().code, "INVALID_JSON");
            assert!(!serde_json::to_string(&response)
                .unwrap()
                .contains("DONT_EXPORT_SECRET"));
        }
    }
    assert_eq!(
        call(&core, "ssh.info", json!({"password":"DONT_EXPORT_SECRET"}))
            .error
            .unwrap()
            .code,
        "INVALID_PARAMS"
    );
    let mut invalid = connection;
    invalid["host"] = json!("-bad");
    assert_eq!(
        call(&core, "ssh.resolve", json!({"connection":invalid}))
            .error
            .unwrap()
            .code,
        "SSH_INVALID_HOST"
    );
    assert!(!root
        .path()
        .join("shared-state-v1/snapshot-v1.json")
        .exists());
    assert!(!root.path().join("local-daemon-v1").exists());
    core.close();
    if let Some(path) = std::env::var_os("UTERM_SSH_CONFIGURATION_REPORT") {
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(env!("CARGO_MANIFEST_DIR"))
                .output()
                .unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        let tested = git(&["rev-parse", "HEAD"]);
        let version = Command::new(utermd_local::ssh::program().unwrap())
            .arg("-V")
            .output()
            .unwrap();
        assert!(version.status.success());
        std::fs::write(path, serde_json::to_vec_pretty(&json!({
            "passed":true,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
            "sourceHeadSHA":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_|tested.clone()),
            "testedMergeSHA":tested,"sourceTreeDirty":!git(&["status","--porcelain","--untracked-files=no"]).is_empty(),
            "openSSHVersion":String::from_utf8_lossy(&version.stderr).trim(),
            "actualConfigurationResolution":true,"literalPortRepresentation":"2222",
            "unknownSecretFieldsRejected":true,"secretValuesNotEchoed":true,
            "invalidHostRejected":true,"snapshotUnchanged":true,"hostNotStarted":true,
            "remoteLogin":false,"authenticatedServiceAcceptance":false,"nativeConnectionUIAcceptance":false
        })).unwrap()).unwrap();
    }
}
