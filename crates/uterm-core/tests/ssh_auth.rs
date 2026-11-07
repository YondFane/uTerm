use anyhow::Result;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use uterm_core::{credentials::Credentials, ssh::auth::SshAuth};
use utermd_local::ssh::SshTarget;

#[derive(Default)]
struct MemoryCredentials(Mutex<HashMap<String, Vec<u8>>>);
impl Credentials for MemoryCredentials {
    fn access(&self, reference: &str, value: Option<Option<Vec<u8>>>) -> Result<Option<Vec<u8>>> {
        uterm_core::credentials::validate_reference(reference)?;
        let mut values = self.0.lock().unwrap();
        match value {
            Some(Some(bytes)) => {
                values.insert(reference.into(), bytes);
                Ok(None)
            }
            Some(None) => {
                values.remove(reference);
                Ok(None)
            }
            None => Ok(values.get(reference).cloned()),
        }
    }
}
fn connection() -> SshTarget {
    SshTarget {
        connection_id: uuid::Uuid::new_v4().to_string(),
        workspace_id: "local".into(),
        host: "127.0.0.1".into(),
        name: "SSH QA".into(),
        os: "posix".into(),
        mode: Some("direct".into()),
        port: Some(2222),
        username: Some("qa".into()),
        authentication: Some("password".into()),
        ..Default::default()
    }
}

#[tokio::test]
async fn references_survive_rename_but_refuse_changed_connection_or_effective_endpoint() {
    let credentials = Arc::new(MemoryCredentials::default());
    let auth = SshAuth::default();
    let mut target = connection();
    let reference = auth
        .configure(
            credentials.clone(),
            target.clone(),
            Some("isolated-fixture".into()),
            true,
        )
        .await
        .unwrap()
        .unwrap();
    target.credential_id = Some(reference.clone());
    target.remember_password = Some(true);
    target.name = "Renamed".into();
    assert_eq!(
        auth.configure(credentials.clone(), target.clone(), None, true)
            .await
            .unwrap(),
        Some(reference.clone())
    );
    for changed in [
        SshTarget {
            connection_id: uuid::Uuid::new_v4().to_string(),
            ..target.clone()
        },
        SshTarget {
            port: Some(2223),
            ..target.clone()
        },
        SshTarget {
            username: Some("other".into()),
            ..target.clone()
        },
    ] {
        assert_eq!(
            auth.configure(credentials.clone(), changed, None, false)
                .await
                .unwrap_err()
                .to_string(),
            "SSH_CREDENTIAL_TARGET_CHANGED"
        );
    }
    let temporary = auth
        .configure(credentials.clone(), target.clone(), None, false)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(temporary, reference);
    target.credential_id = Some(temporary.clone());
    target.remember_password = Some(false);
    assert!(auth
        .prepare(&target, credentials.clone(), |_| false)
        .await
        .unwrap()
        .askpass
        .is_some());
    auth.forget(credentials.clone(), temporary, false)
        .await
        .unwrap();
    assert_eq!(
        auth.configure(credentials.clone(), target, None, false)
            .await
            .unwrap_err()
            .to_string(),
        "SSH_PASSWORD_REQUIRED"
    );
    auth.forget(credentials.clone(), reference.clone(), true)
        .await
        .unwrap();
    assert!(credentials.0.lock().unwrap().is_empty());
    auth.forget(credentials, reference, true).await.unwrap();
}

#[tokio::test]
async fn malformed_storage_and_invalid_secrets_are_redacted_and_proxy_passwords_refused() {
    let credentials = Arc::new(MemoryCredentials::default());
    let auth = SshAuth::default();
    for password in [
        String::new(),
        "x".repeat(1024),
        "bad\npassword".into(),
        "bad\0password".into(),
    ] {
        let error = auth
            .configure(credentials.clone(), connection(), Some(password), false)
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "SSH_PASSWORD_INVALID");
    }
    let mut target = connection();
    let reference = uuid::Uuid::new_v4().to_string();
    credentials
        .0
        .lock()
        .unwrap()
        .insert(reference.clone(), b"SECRET-CONTENT-not-json".to_vec());
    target.credential_id = Some(reference);
    target.remember_password = Some(true);
    assert_eq!(
        auth.configure(credentials.clone(), target, None, true)
            .await
            .unwrap_err()
            .to_string(),
        "SSH_CREDENTIAL_FAILED"
    );
    let mut target = connection();
    target.jump_host = Some("jump.invalid".into());
    assert_eq!(
        auth.configure(credentials.clone(), target, Some("fixture".into()), false)
            .await
            .unwrap_err()
            .to_string(),
        "SSH_PASSWORD_PROXY_UNSUPPORTED"
    );
    let mut target = connection();
    target.authentication = Some("config".into());
    assert_eq!(
        auth.configure(credentials.clone(), target.clone(), None, false)
            .await
            .unwrap(),
        None
    );
    assert!(auth
        .prepare(&target, credentials, |_| false)
        .await
        .unwrap()
        .askpass
        .is_none());
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn actual_os_store_is_isolated_and_reference_deletion_is_idempotent() {
    use uterm_core::credentials::SystemCredentials;
    let store = SystemCredentials::new(format!("sh.uterm.desktop.qa.ssh.{}", uuid::Uuid::new_v4()))
        .unwrap();
    let reference = uuid::Uuid::new_v4().to_string();
    assert_eq!(store.access(&reference, None).unwrap(), None);
    store
        .access(&reference, Some(Some(b"isolated-test-value".to_vec())))
        .unwrap();
    let result = store.access(&reference, None);
    store.access(&reference, Some(None)).unwrap();
    store.access(&reference, Some(None)).unwrap();
    assert_eq!(store.access(&reference, None).unwrap(), None);
    assert_eq!(result.unwrap(), Some(b"isolated-test-value".to_vec()));
}
