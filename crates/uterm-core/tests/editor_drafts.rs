use std::fs;
use uterm_core::store::{EditorDraft, Store};

fn draft(path: &str, text: &str) -> EditorDraft {
    EditorDraft {
        directory: "/qa/project".into(),
        path: path.into(),
        kind: "text".into(),
        text: text.into(),
        saved: "saved\r\n".into(),
        version: "a".repeat(64),
        line_ending: "\r\n".into(),
        bom: true,
    }
}

#[test]
fn legacy_import_keeps_exact_sources_and_does_not_replace_newer_or_conflicting_drafts() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_owned()).unwrap();
    let mut value = serde_json::to_value(draft("中文.md", "未保存 é\r\n")).unwrap();
    value["id"] = serde_json::json!(19);
    value["notice"] = serde_json::json!("Legacy metadata");
    let raw = format!(" \n{}\n", serde_json::to_string_pretty(&value).unwrap());
    let imported = store.editor_import(Some(&raw)).unwrap();
    let source = root.path().join(format!(
        "editor-draft-source-{}.original",
        imported.document.source_digest.unwrap()
    ));
    assert_eq!(fs::read(&source).unwrap(), raw.as_bytes());
    assert_eq!(imported.document.drafts[0].text, "未保存 é\r\n");
    assert!(imported.document.drafts[0].bom);
    let updated = store
        .editor_put(&imported.revision, draft("中文.md", "newer text"))
        .unwrap();
    assert_eq!(
        store.editor_import(Some(&raw)).unwrap().revision,
        updated.revision
    );
    let competing = serde_json::to_string(&draft("中文.md", "different old WebView")).unwrap();
    assert_eq!(
        store.editor_import(Some(&competing)).unwrap_err().code,
        "MIGRATION_CONFLICT"
    );
    let recovery = store.editor_recovery_list().unwrap();
    assert_eq!(recovery["sources"].as_array().unwrap().len(), 2);
    assert_eq!(store.editor_read().unwrap().revision, updated.revision);
    assert_eq!(fs::read(source).unwrap(), raw.as_bytes());
}

#[test]
fn separate_clients_keep_multiple_documents_and_reject_stale_updates_and_removal() {
    let root = tempfile::tempdir().unwrap();
    let first = Store::open(root.path().to_owned()).unwrap();
    let second = Store::open(root.path().to_owned()).unwrap();
    let empty = first.editor_import(None).unwrap();
    let a = first
        .editor_put(&empty.revision, draft("a.txt", "A"))
        .unwrap();
    assert_eq!(
        second
            .editor_put(&empty.revision, draft("b.txt", "B"))
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    let b = second
        .editor_put(&second.editor_read().unwrap().revision, draft("b.txt", "B"))
        .unwrap();
    assert_eq!(b.document.drafts.len(), 2);
    assert_eq!(
        first
            .editor_put(&a.revision, draft("a.txt", "stale"))
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    assert_eq!(
        first
            .editor_remove(&a.revision, "/qa/project", "b.txt")
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    assert_eq!(
        first
            .editor_put(&b.revision, draft("a.txt", "A"))
            .unwrap()
            .revision,
        b.revision
    );
    let removed = first
        .editor_remove(&b.revision, "/qa/project", "a.txt")
        .unwrap();
    let reopened = Store::open(root.path().to_owned())
        .unwrap()
        .editor_read()
        .unwrap();
    assert_eq!(reopened.revision, removed.revision);
    assert_eq!(reopened.document.drafts, vec![draft("b.txt", "B")]);
}

#[test]
fn document_revisions_allow_independent_writers_and_never_delete_a_replacement() {
    let root = tempfile::tempdir().unwrap();
    let first = Store::open(root.path().to_owned()).unwrap();
    let second = Store::open(root.path().to_owned()).unwrap();
    first.editor_import(None).unwrap();
    let a = first
        .editor_put_document(None, draft("a.txt", "A"))
        .unwrap();
    let b = second
        .editor_put_document(None, draft("b.txt", "B"))
        .unwrap();
    let changed = second
        .editor_put_document(Some(&a.revision), draft("a.txt", "new A"))
        .unwrap();
    assert_ne!(changed.revision, a.revision);
    assert_eq!(
        first
            .editor_put_document(Some(&a.revision), draft("a.txt", "stale A"))
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    assert_eq!(
        first
            .editor_remove_document(Some(&a.revision), "/qa/project", "a.txt")
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    first
        .editor_remove_document(Some(&b.revision), "/qa/project", "b.txt")
        .unwrap();
    assert_eq!(
        second
            .editor_document("/qa/project", "a.txt")
            .unwrap()
            .unwrap()
            .draft
            .text,
        "new A"
    );
    assert!(second
        .editor_document("/qa/project", "b.txt")
        .unwrap()
        .is_none());
    let before = second.editor_read().unwrap().revision;
    assert_eq!(
        second
            .editor_put_document(Some(&changed.revision), draft("a.txt", "new A"))
            .unwrap()
            .revision,
        changed.revision
    );
    assert_eq!(second.editor_read().unwrap().revision, before);
    assert_eq!(
        first
            .editor_remove_document(Some("invalid"), "/qa/project", "a.txt")
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
}

#[test]
fn scoped_draft_listing_returns_only_the_requested_project() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_owned()).unwrap();
    store.editor_import(None).unwrap();
    store
        .editor_put_document(None, draft("a.txt", "visible"))
        .unwrap();
    let mut other = draft("a.txt", "other project secret");
    other.directory = "/qa/other".into();
    store.editor_put_document(None, other).unwrap();
    let scoped = store.editor_list(Some("/qa/project")).unwrap();
    assert_eq!(scoped.drafts.len(), 1);
    assert_eq!(scoped.drafts[0].draft.text, "visible");
    assert_eq!(store.editor_list(None).unwrap().drafts.len(), 2);
    assert_eq!(
        store.editor_list(Some("/qa/missing")).unwrap().drafts.len(),
        0
    );
}

#[test]
fn missing_store_with_recovery_evidence_cannot_be_imported_as_a_new_empty_store() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_owned()).unwrap();
    let raw = serde_json::to_string(&draft("a.txt", "first original")).unwrap();
    let first = store.editor_import(Some(&raw)).unwrap();
    store
        .editor_put(&first.revision, draft("a.txt", "newer text"))
        .unwrap();
    let path = root.path().join("editor-drafts-v1.json");
    fs::remove_file(&path).unwrap();
    let read_code = store.editor_read().unwrap_err().code;
    let imported = store.editor_import(Some(&raw));
    assert!(
        imported.is_err(),
        "Missing draft store was silently recreated from an older source"
    );
    assert_eq!(read_code, "MISSING_DRAFTS");
    assert_eq!(imported.unwrap_err().code, "MISSING_DRAFTS");
    assert!(!path.exists());
    assert_eq!(
        store.editor_recovery_list().unwrap()["backups"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.editor_recovery_list().unwrap()["sources"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let preview = store.editor_preview(&first.revision).unwrap();
    assert_eq!(preview.revision, first.revision);
    assert_eq!(preview.document.drafts[0].text, "first original");
    assert!(!path.exists());
    let restored = store.editor_recover_missing(&first.revision).unwrap();
    assert_eq!(restored.revision, first.revision);
    let before = fs::read(&path).unwrap();
    assert_eq!(
        store
            .editor_recover_missing(&first.revision)
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    for invalid in ["", "../editor-drafts-v1.json", &"g".repeat(64)] {
        assert_eq!(
            store.editor_preview(invalid).unwrap_err().code,
            "INVALID_ARGUMENT"
        );
    }
    fs::remove_file(&path).unwrap();
    let backup = root
        .path()
        .join(format!("editor-drafts-{}.backup", first.revision));
    fs::write(&backup, b"wrong bytes retained").unwrap();
    assert_eq!(
        store.editor_preview(&first.revision).unwrap_err().code,
        "CORRUPT_DRAFTS"
    );
    assert_eq!(
        store
            .editor_recover_missing(&first.revision)
            .unwrap_err()
            .code,
        "CORRUPT_DRAFTS"
    );
    assert!(!path.exists());
    assert_eq!(fs::read(backup).unwrap(), b"wrong bytes retained");
}

#[test]
fn corrupt_storage_and_wrong_backups_preserve_bytes_until_explicit_checked_recovery() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_owned()).unwrap();
    let raw = serde_json::to_string(&draft("a.txt", "original")).unwrap();
    let first = store.editor_import(Some(&raw)).unwrap();
    let second = store
        .editor_put(&first.revision, draft("a.txt", "changed"))
        .unwrap();
    let path = root.path().join("editor-drafts-v1.json");
    let damaged = b"{broken\n";
    fs::write(&path, damaged).unwrap();
    assert_eq!(store.editor_read().unwrap_err().code, "CORRUPT_DRAFTS");
    assert_eq!(
        store.editor_import(Some(&raw)).unwrap_err().code,
        "CORRUPT_DRAFTS"
    );
    let list = store.editor_recovery_list().unwrap();
    assert_eq!(
        store
            .editor_preview(&first.revision)
            .unwrap()
            .document
            .drafts[0]
            .text,
        "original"
    );
    assert_eq!(fs::read(&path).unwrap(), damaged);
    let current = list["currentRevision"].as_str().unwrap();
    assert_eq!(
        store
            .editor_recover(&second.revision, &first.revision)
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    assert_eq!(fs::read(&path).unwrap(), damaged);
    let restored = store.editor_recover(current, &first.revision).unwrap();
    assert_eq!(restored.revision, first.revision);
    assert_eq!(
        fs::read(root.path().join(format!("editor-drafts-{current}.damaged"))).unwrap(),
        damaged
    );
    let backup = root
        .path()
        .join(format!("editor-drafts-{}.backup", first.revision));
    fs::write(&backup, b"wrong backup").unwrap();
    assert!(store.editor_recovery_list().unwrap()["backups"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .editor_put(&first.revision, draft("a.txt", "never committed"))
            .unwrap_err()
            .code,
        "CORRUPT_STORE"
    );
    assert_eq!(store.editor_read().unwrap().revision, first.revision);
    assert_eq!(fs::read(backup).unwrap(), b"wrong backup");
}

#[test]
fn invalid_legacy_bytes_and_source_limit_never_reset_existing_recovery_data() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_owned()).unwrap();
    for index in 0..16 {
        let raw = format!("broken legacy {index}");
        assert_eq!(
            store.editor_import(Some(&raw)).unwrap_err().code,
            "INVALID_DRAFT"
        );
    }
    assert_eq!(
        store.editor_recovery_list().unwrap()["sources"]
            .as_array()
            .unwrap()
            .len(),
        16
    );
    assert_eq!(
        store
            .editor_import(Some("one more source"))
            .unwrap_err()
            .code,
        "DRAFT_SOURCE_LIMIT"
    );
    assert_eq!(store.editor_read().unwrap_err().code, "DRAFTS_NOT_IMPORTED");
    let empty = store.editor_import(None).unwrap();
    assert!(empty.document.drafts.is_empty());
    assert_eq!(
        store.editor_recovery_list().unwrap()["sources"]
            .as_array()
            .unwrap()
            .len(),
        16
    );
}

#[test]
fn utf16_length_limits_match_javascript_and_text_metadata_survives_reopen() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_owned()).unwrap();
    let empty = store.editor_import(None).unwrap();
    let text = "𝄞".repeat(1024 * 1024);
    let valid = draft("music.txt", &text);
    let written = store.editor_put(&empty.revision, valid.clone()).unwrap();
    assert_eq!(store.editor_read().unwrap().document.drafts[0], valid);
    let mut invalid = valid;
    invalid.text.push('x');
    assert_eq!(
        store
            .editor_put(&written.revision, invalid)
            .unwrap_err()
            .code,
        "INVALID_DRAFT"
    );
    assert_eq!(store.editor_read().unwrap().revision, written.revision);
    for path in ["../escape", "/absolute", "C:\\escape", "safe/../escape"] {
        assert_eq!(
            store
                .editor_put(&written.revision, draft(path, "bad path"))
                .unwrap_err()
                .code,
            "INVALID_DRAFT"
        );
    }
}

#[test]
fn retained_snapshot_backups_are_bounded_without_pruning_original_sources() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_owned()).unwrap();
    let raw = serde_json::to_string(&draft("a.txt", "original")).unwrap();
    let mut current = store.editor_import(Some(&raw)).unwrap();
    let invalid_backup = root
        .path()
        .join(format!("editor-drafts-{}.backup", "b".repeat(64)));
    fs::write(&invalid_backup, b"invalid recovery bytes").unwrap();
    for index in 0..12 {
        current = store
            .editor_put(&current.revision, draft("a.txt", &index.to_string()))
            .unwrap();
    }
    let list = store.editor_recovery_list().unwrap();
    assert_eq!(list["backups"].as_array().unwrap().len(), 8);
    assert_eq!(list["sources"].as_array().unwrap().len(), 1);
    assert_eq!(fs::read(invalid_backup).unwrap(), b"invalid recovery bytes");
}

#[test]
fn full_collection_rejects_new_documents_without_losing_or_blocking_existing_drafts() {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_owned()).unwrap();
    let document = uterm_core::store::EditorDraftDocument {
        schema_version: 1,
        source_digest: None,
        drafts: (0..100)
            .map(|i| draft(&format!("{i}.txt"), "retained"))
            .collect(),
    };
    fs::write(
        root.path().join("editor-drafts-v1.json"),
        serde_json::to_vec_pretty(&document).unwrap(),
    )
    .unwrap();
    let before = store.editor_read().unwrap();
    assert_eq!(
        store
            .editor_put(&before.revision, draft("overflow.txt", "keep local"))
            .unwrap_err()
            .code,
        "DRAFT_LIMIT"
    );
    assert_eq!(store.editor_read().unwrap().revision, before.revision);
    let updated = store
        .editor_put(&before.revision, draft("0.txt", "edited"))
        .unwrap();
    assert_eq!(updated.document.drafts.len(), 100);
    assert_eq!(
        updated
            .document
            .drafts
            .iter()
            .find(|d| d.path == "0.txt")
            .unwrap()
            .text,
        "edited"
    );
}

#[cfg(unix)]
#[test]
fn dangling_or_external_draft_symlinks_are_not_replaced_by_an_import() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_owned()).unwrap();
    let link = root.path().join("editor-drafts-v1.json");
    let target = outside.path().join("missing");
    symlink(&target, &link).unwrap();
    assert!(store.editor_import(None).is_err());
    assert_eq!(fs::read_link(&link).unwrap(), target);
    fs::write(&target, b"outside bytes").unwrap();
    assert!(store.editor_import(None).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"outside bytes");
    assert_eq!(fs::read_link(&link).unwrap(), target);
}

#[cfg(unix)]
#[test]
#[ignore = "Run explicitly as an unprivileged user with pnpm test:core"]
fn filesystem_failure_preserves_editor_drafts_and_allows_retry() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_owned()).unwrap();
    let raw = serde_json::to_string(&draft("a.txt", "retained")).unwrap();
    let before = store.editor_import(Some(&raw)).unwrap();
    let path = root.path().join("editor-drafts-v1.json");
    let bytes = fs::read(&path).unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o500)).unwrap();
    let failed = store.editor_put(&before.revision, draft("a.txt", "retry"));
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        failed.unwrap_err().code,
        "IO",
        "This case requires an unprivileged user"
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(store.editor_read().unwrap().revision, before.revision);
    let source = root.path().join(format!(
        "editor-draft-source-{}.original",
        before.document.source_digest.unwrap()
    ));
    assert_eq!(fs::read(source).unwrap(), raw.as_bytes());
    assert!(store
        .editor_put(&before.revision, draft("a.txt", "retry"))
        .is_ok());
}

#[cfg(windows)]
#[test]
#[ignore = "Run explicitly on the platform filesystem with pnpm test:core"]
fn filesystem_failure_preserves_editor_drafts_and_allows_retry() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().to_owned()).unwrap();
    let raw = serde_json::to_string(&draft("a.txt", "retained")).unwrap();
    let before = store.editor_import(Some(&raw)).unwrap();
    let path = root.path().join("editor-drafts-v1.json");
    let bytes = fs::read(&path).unwrap();
    let lease = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .unwrap();
    let failed = store.editor_put(&before.revision, draft("a.txt", "retry"));
    assert_eq!(failed.unwrap_err().code, "IO");
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(store.editor_read().unwrap().revision, before.revision);
    let source = root.path().join(format!(
        "editor-draft-source-{}.original",
        before.document.source_digest.unwrap()
    ));
    assert_eq!(fs::read(source).unwrap(), raw.as_bytes());
    drop(lease);
    assert!(store
        .editor_put(&before.revision, draft("a.txt", "retry"))
        .is_ok());
}
