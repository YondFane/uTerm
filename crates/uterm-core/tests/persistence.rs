use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, fs::OpenOptions};
use uterm_core::{
    state,
    store::{Import, Store},
    Core,
};

fn import() -> Import {
    let baseline = state::defaults();
    Import {
        workspace: baseline["workspace"].clone(),
        settings: baseline["settings"].clone(),
        legacy: BTreeMap::from([
            (
                "uterm.desktop.workspace.v1".into(),
                " { \"version\": 7, \"opaque\": null } ".into(),
            ),
            (
                "uterm.desktop.editorDraft.v1".into(),
                "{\"text\":\"未保存\\n中文\",\"version\":null}".into(),
            ),
        ]),
    }
}
#[test]
fn import_reentry_preserves_newer_data_and_raw_recovery_bytes() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_path_buf()).unwrap();
    let first = store.import(import()).unwrap();
    let raw = fs::read(root.path().join("legacy-original.json")).unwrap();
    let next = store
        .update(&first.revision, |doc| {
            doc.settings["fontSize"] = json!(20);
            Ok(())
        })
        .unwrap();
    assert_ne!(first.revision, next.revision);
    let reentered = store.import(import()).unwrap();
    assert_eq!(reentered.revision, next.revision);
    assert_eq!(reentered.document.settings["fontSize"], 20);
    assert_eq!(
        fs::read(root.path().join("legacy-original.json")).unwrap(),
        raw
    );
    assert_eq!(
        reentered.document.legacy["uterm.desktop.editorDraft.v1"],
        import().legacy["uterm.desktop.editorDraft.v1"]
    );
}
#[test]
fn stale_writes_and_new_migrations_cannot_overwrite_state() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_path_buf()).unwrap();
    let first = store.import(import()).unwrap();
    let bytes = fs::read(root.path().join("snapshot-v1.json")).unwrap();
    assert_eq!(
        store.update("stale", |_| Ok(())).unwrap_err().code,
        "CONFLICT"
    );
    let mut other = import();
    other.legacy.insert("changed".into(), "true".into());
    assert_eq!(store.import(other).unwrap_err().code, "MIGRATION_CONFLICT");
    assert_eq!(
        bytes,
        fs::read(root.path().join("snapshot-v1.json")).unwrap()
    );
    assert_eq!(first.revision, store.read().unwrap().revision);
}
#[test]
fn corruption_and_unsupported_schema_are_retained_without_default_reset() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_path_buf()).unwrap();
    store.import(import()).unwrap();
    let path = root.path().join("snapshot-v1.json");
    for bytes in [b"{broken".to_vec(),b"{\"schemaVersion\":500,\"migrationId\":\"x\",\"workspace\":{},\"settings\":{},\"legacy\":{}}".to_vec()] {
        fs::write(&path,&bytes).unwrap();
        assert!(store.read().is_err());assert!(store.import(import()).is_err());
        assert_eq!(fs::read(&path).unwrap(),bytes);
    }
}
#[test]
fn independent_clients_observe_the_single_writer_lease() {
    let root = tempfile::tempdir().unwrap();
    let first = Store::open(root.path().to_path_buf()).unwrap();
    let second = Store::open(root.path().to_path_buf()).unwrap();
    first.import(import()).unwrap();
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join("writer.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    assert_eq!(second.read().unwrap_err().code, "WRITER_BUSY");
    drop(lock);
    assert!(second.read().is_ok());
}
#[test]
fn invalid_changes_leave_snapshot_and_backup_intact() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_path_buf()).unwrap();
    let before = store.import(import()).unwrap();
    let error = store
        .update(&before.revision, |doc| {
            doc.settings["fontSize"] = Value::Null;
            Ok(())
        })
        .unwrap_err();
    assert_eq!(error.code, "INVALID_SETTINGS");
    assert_eq!(store.read().unwrap().revision, before.revision);
}

#[test]
fn explicit_recovery_checks_revision_and_preserves_damaged_bytes() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().into()).unwrap();
    let initial = store.import(import()).unwrap();
    store
        .update(&initial.revision, |doc| {
            doc.settings["fontSize"] = json!(22);
            Ok(())
        })
        .unwrap();
    let damaged = b"{interrupted external edit";
    fs::write(root.path().join("snapshot-v1.json"), damaged).unwrap();
    let listing = store.recovery_list().unwrap();
    assert!(listing["backups"]
        .as_array()
        .unwrap()
        .contains(&json!(initial.revision)));
    assert_eq!(
        store.recover("stale", &initial.revision).unwrap_err().code,
        "CONFLICT"
    );
    assert!(store
        .recover(
            listing["currentRevision"].as_str().unwrap(),
            "../snapshot-v1.json"
        )
        .is_err());
    let restored = store
        .recover(
            listing["currentRevision"].as_str().unwrap(),
            &initial.revision,
        )
        .unwrap();
    assert_eq!(restored.document.settings["fontSize"], 14);
    assert_eq!(
        fs::read(root.path().join(format!(
            "snapshot-{}.damaged",
            listing["currentRevision"].as_str().unwrap()
        )))
        .unwrap(),
        damaged
    );
}
#[test]
fn shared_transitions_protect_populated_and_last_workspaces() {
    let mut workspace = state::defaults()["workspace"].clone();
    let original = workspace.clone();
    state::transition(&mut workspace, "workspace.remove", &json!({"id":"local"})).unwrap();
    assert_eq!(workspace, original);
    state::transition(
        &mut workspace,
        "workspace.create",
        &json!({"id":"other","name":"Other"}),
    )
    .unwrap();
    state::transition(
        &mut workspace,
        "project.add",
        &json!({"id":"p","name":"项目","directory":"/tmp/project","workspaceId":"local"}),
    )
    .unwrap();
    state::transition(&mut workspace, "workspace.remove", &json!({"id":"local"})).unwrap();
    assert_eq!(workspace["groups"].as_array().unwrap().len(), 2);
    state::transition(&mut workspace, "project.remove", &json!({"id":"p"})).unwrap();
    state::transition(&mut workspace, "workspace.remove", &json!({"id":"local"})).unwrap();
    assert_eq!(workspace["groups"].as_array().unwrap().len(), 1);
    assert_eq!(workspace["selectedWorkspace"], "other");
}
#[test]
fn duplicate_ids_and_broken_project_references_are_rejected() {
    let mut workspace = state::defaults()["workspace"].clone();
    workspace["projects"] =
        json!([{"id":"local","name":"p","directory":"/p","workspaceId":"local","sessions":[]}]);
    assert!(state::validate_workspace(&workspace).is_err());
    workspace["projects"][0]["id"] = json!("p");
    workspace["projects"][0]["workspaceId"] = json!("missing");
    assert!(state::validate_workspace(&workspace).is_err());
}
#[test]
fn contract_errors_preserve_operation_identity_and_do_not_mutate() {
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().into()).unwrap();
    let reply = core.execute(br#"{"version":900,"id":"request-2","method":"snapshot.read"}"#);
    assert_eq!(reply.id, "request-2");
    assert_eq!(reply.error.unwrap().code, "UNSUPPORTED_VERSION");
    assert!(core.execute(b"not json").error.is_some());
    let reply = core.execute(br#"{"version":1,"id":"request-3","method":"unknown"}"#);
    assert_eq!(reply.error.unwrap().code, "UNKNOWN_METHOD");
}
#[test]
fn legacy_export_contains_current_state_and_retains_opaque_drafts() {
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().into()).unwrap();
    let input = import();
    let request = json!({"version":1,"id":"import","method":"migration.import","params":{"workspace":input.workspace,"settings":input.settings,"legacy":input.legacy}});
    let imported = core
        .execute(&serde_json::to_vec(&request).unwrap())
        .result
        .unwrap();
    let changed=core.execute(&serde_json::to_vec(&json!({"version":1,"id":"change","method":"settings.patch","params":{"expectedRevision":imported["revision"],"patch":{"fontSize":20}}})).unwrap());
    assert!(changed.error.is_none());
    let exported = core
        .execute(br#"{"version":1,"id":"export","method":"legacy.export"}"#)
        .result
        .unwrap();
    let settings: Value = serde_json::from_str(
        exported["values"]["uterm.desktop.settings.v1"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(settings["fontSize"], 20);
    assert_eq!(
        exported["values"]["uterm.desktop.editorDraft.v1"],
        import().legacy["uterm.desktop.editorDraft.v1"]
    );
}

#[test]
fn occupied_backup_path_cannot_silently_skip_recovery_before_a_write() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().into()).unwrap();
    let before = store.import(import()).unwrap();
    let original = fs::read(root.path().join("snapshot-v1.json")).unwrap();
    let backup = root
        .path()
        .join(format!("snapshot-{}.backup", before.revision));
    fs::create_dir(&backup).unwrap();
    let failed = store.update(&before.revision, |doc| {
        doc.settings["fontSize"] = json!(20);
        Ok(())
    });
    assert_eq!(failed.unwrap_err().code, "CORRUPT_STORE");
    assert_eq!(
        fs::read(root.path().join("snapshot-v1.json")).unwrap(),
        original
    );
    assert!(backup.is_dir());
    fs::remove_dir(&backup).unwrap();
    assert!(store
        .update(&before.revision, |doc| {
            doc.settings["fontSize"] = json!(20);
            Ok(())
        })
        .is_ok());
    assert_eq!(fs::read(backup).unwrap(), original);
}

#[test]
fn valid_json_with_wrong_checksum_is_not_a_recovery_copy() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().into()).unwrap();
    let before = store.import(import()).unwrap();
    let mut other = before.document.clone();
    other.settings["fontSize"] = json!(23);
    let bytes = serde_json::to_vec(&other).unwrap();
    let backup = root
        .path()
        .join(format!("snapshot-{}.backup", before.revision));
    fs::write(&backup, &bytes).unwrap();
    assert!(store.recovery_list().unwrap()["backups"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .update(&before.revision, |doc| {
                doc.settings["fontSize"] = json!(20);
                Ok(())
            })
            .unwrap_err()
            .code,
        "CORRUPT_STORE"
    );
    assert_eq!(store.read().unwrap().revision, before.revision);
    assert_eq!(fs::read(backup).unwrap(), bytes);
}

#[cfg(unix)]
#[test]
#[ignore = "Run explicitly with an unprivileged user to enforce filesystem permissions"]
fn filesystem_failure_preserves_snapshot_and_allows_retry() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().into()).unwrap();
    let before = store.import(import()).unwrap();
    let bytes = fs::read(root.path().join("snapshot-v1.json")).unwrap();
    let original = fs::read(root.path().join("legacy-original.json")).unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o500)).unwrap();
    let failed = store.update(&before.revision, |doc| {
        doc.settings["fontSize"] = json!(20);
        Ok(())
    });
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        failed.unwrap_err().code,
        "IO",
        "This case requires an unprivileged user"
    );
    assert_eq!(
        fs::read(root.path().join("snapshot-v1.json")).unwrap(),
        bytes
    );
    assert_eq!(
        fs::read(root.path().join("legacy-original.json")).unwrap(),
        original
    );
    assert_eq!(store.read().unwrap().revision, before.revision);
    assert!(store
        .update(&before.revision, |doc| {
            doc.settings["fontSize"] = json!(20);
            Ok(())
        })
        .is_ok());
}

#[cfg(windows)]
#[test]
fn filesystem_failure_preserves_snapshot_and_allows_retry() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().into()).unwrap();
    let before = store.import(import()).unwrap();
    let path = root.path().join("snapshot-v1.json");
    let bytes = fs::read(&path).unwrap();
    let lease = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .unwrap();
    let failed = store.update(&before.revision, |doc| {
        doc.settings["fontSize"] = json!(20);
        Ok(())
    });
    assert_eq!(failed.unwrap_err().code, "IO");
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(
        fs::read(
            root.path()
                .join(format!("snapshot-{}.backup", before.revision))
        )
        .unwrap(),
        bytes
    );
    drop(lease);
    assert_eq!(store.read().unwrap().revision, before.revision);
    assert!(store
        .update(&before.revision, |doc| {
            doc.settings["fontSize"] = json!(20);
            Ok(())
        })
        .is_ok());
}
