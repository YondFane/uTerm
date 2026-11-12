use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use uterm_core::{Core, Response};

fn call(core: &Core, method: &str, params: Value) -> Response {
    core.execute(
        &serde_json::to_vec(&json!({"version":1,"id":"pdf-qa","method":method,"params":params}))
            .unwrap(),
    )
}
fn success(core: &Core, method: &str, params: Value) -> Value {
    let response = call(core, method, params);
    assert!(response.error.is_none(), "{:?}", response.error);
    response.result.unwrap()
}
fn target() -> Value {
    json!({"directory":"/qa/中文 project","path":"document.pdf","version":"a".repeat(64)})
}
fn mark(id: &str) -> Value {
    json!({"id":id,"page":1,"x":0.1234567890123456,"y":0.2,"width":0.4,"height":0.3})
}
fn fixture(legacy: Value) -> (tempfile::TempDir, Core) {
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().to_path_buf()).unwrap();
    let defaults = success(&core, "state.defaults", Value::Null);
    success(
        &core,
        "migration.import",
        json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":legacy}),
    );
    (root, core)
}
fn read(core: &Core, target: &Value) -> Value {
    success(core, "pdf.marks.read", target.clone())
}
fn write(core: &Core, target: &Value, revision: &Value, marks: Value) -> Response {
    let mut params = target.clone();
    params["expectedRevision"] = revision.clone();
    params["marks"] = marks;
    call(core, "pdf.marks.write", params)
}
fn file(root: &tempfile::TempDir) -> PathBuf {
    fs::read_dir(root.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("pdf-marks-")
                && path.extension().is_some_and(|v| v == "json")
        })
        .unwrap()
}

#[test]
fn scoped_coordinates_survive_reopening_and_do_not_change_pdf_bytes() {
    let (root, core) = fixture(json!({}));
    let pdf = root.path().join("source.pdf");
    let bytes = b"%PDF-1.7\nORIGINAL_PDF_BYTES\n";
    fs::write(&pdf, bytes).unwrap();
    let mut selected = target();
    selected["directory"] = json!(root.path());
    selected["path"] = json!("source.pdf");
    let original = read(&core, &selected);
    assert_eq!(original["marks"], json!([]));
    let saved = write(
        &core,
        &selected,
        &original["revision"],
        json!([mark("one")]),
    )
    .result
    .unwrap();
    assert_ne!(saved["revision"], original["revision"]);
    assert!((saved["marks"][0]["x"].as_f64().unwrap() - 0.1234567890123456).abs() < 1e-14);
    core.close();
    let reopened = Core::open(root.path().to_path_buf()).unwrap();
    assert_eq!(read(&reopened, &selected), saved);
    for (key, value) in [
        ("path", json!("other.pdf")),
        ("directory", json!("/other")),
        ("version", json!("b".repeat(64))),
    ] {
        let mut other = selected.clone();
        other[key] = value;
        assert_eq!(read(&reopened, &other)["marks"], json!([]));
    }
    assert_eq!(fs::read(pdf).unwrap(), bytes);
    reopened.close();
}

#[test]
fn independent_clients_reject_stale_writes_without_changing_saved_bytes() {
    let (root, first) = fixture(json!({}));
    let second = Core::open(root.path().to_path_buf()).unwrap();
    let selected = target();
    let revision = read(&second, &selected)["revision"].clone();
    let saved = write(&first, &selected, &revision, json!([mark("first")]))
        .result
        .unwrap();
    let path = file(&root);
    let bytes = fs::read(&path).unwrap();
    assert_eq!(
        write(&second, &selected, &revision, json!([mark("second")]))
            .error
            .unwrap()
            .code,
        "CONFLICT"
    );
    assert_eq!(fs::read(path).unwrap(), bytes);
    assert_eq!(read(&second, &selected), saved);
    first.close();
    second.close();
}

#[test]
fn malformed_targets_marks_and_private_fields_retain_existing_records() {
    let (root, core) = fixture(json!({}));
    let selected = target();
    let saved = write(
        &core,
        &selected,
        &read(&core, &selected)["revision"],
        json!([mark("valid")]),
    )
    .result
    .unwrap();
    let path = file(&root);
    let bytes = fs::read(&path).unwrap();
    for (key, value) in [
        ("page", json!(0)),
        ("page", json!(1.5)),
        ("x", json!(-0.1)),
        ("width", json!(1.0)),
        ("height", json!(1e300)),
        ("password", json!("DONT_ECHO_PRIVATE")),
    ] {
        let mut bad = mark("bad");
        bad[key] = value;
        let reply = write(&core, &selected, &saved["revision"], json!([bad]));
        assert!(reply.error.is_some(), "{key}");
        assert!(!serde_json::to_string(&reply)
            .unwrap()
            .contains("DONT_ECHO_PRIVATE"));
    }
    assert!(write(
        &core,
        &selected,
        &saved["revision"],
        json!([mark("duplicate"), mark("duplicate")])
    )
    .error
    .is_some());
    assert!(write(
        &core,
        &selected,
        &saved["revision"],
        json!((0..2001).map(|n| mark(&n.to_string())).collect::<Vec<_>>())
    )
    .error
    .is_some());
    for path in ["../private.pdf", "/private.pdf", "C:\\private.pdf"] {
        let mut bad = selected.clone();
        bad["path"] = json!(path);
        assert!(call(&core, "pdf.marks.read", bad).error.is_some());
    }
    let mut bad = selected.clone();
    bad["private_key"] = json!("DONT_ECHO_PRIVATE");
    let reply = call(&core, "pdf.marks.read", bad);
    assert!(reply.error.is_some());
    assert!(!serde_json::to_string(&reply)
        .unwrap()
        .contains("DONT_ECHO_PRIVATE"));
    assert_eq!(fs::read(path).unwrap(), bytes);
    core.close();
}

#[test]
fn legacy_highlights_are_retained_and_current_marks_join_coherent_rollback_exports() {
    let selected = target();
    let key = format!(
        "uterm.pdf.marks:{}/{}:{}",
        selected["directory"].as_str().unwrap(),
        selected["path"].as_str().unwrap(),
        selected["version"].as_str().unwrap()
    );
    let raw = format!(" \n{}\n", json!([mark("old")]));
    let (root, core) = fixture(json!({key.clone():raw.clone()}));
    let source = fs::read(root.path().join("legacy-original.json")).unwrap();
    let old = read(&core, &selected);
    assert_eq!(old["marks"], json!([mark("old")]));
    let saved = write(&core, &selected, &old["revision"], json!([mark("new")]))
        .result
        .unwrap();
    let snapshot = success(&core, "snapshot.read", Value::Null);
    assert_eq!(snapshot["document"]["legacy"][&key], raw);
    let exported = success(&core, "legacy.export", Value::Null);
    assert_eq!(
        serde_json::from_str::<Value>(exported["values"][&key].as_str().unwrap()).unwrap(),
        saved["marks"]
    );
    let archive = success(
        &core,
        "rollback.export",
        json!({"expectedRevision":snapshot["revision"],"expectedDraftRevision":null}),
    );
    assert_eq!(
        serde_json::from_str::<Value>(archive["legacyValues"][&key].as_str().unwrap()).unwrap(),
        saved["marks"]
    );
    assert_eq!(archive["snapshot"]["document"]["legacy"][&key], raw);
    assert_eq!(
        fs::read(root.path().join("legacy-original.json")).unwrap(),
        source
    );
    core.close();
}

#[test]
fn corrupt_future_and_missing_highlights_never_reset_the_record() {
    let (root, core) = fixture(json!({}));
    let selected = target();
    let saved = write(
        &core,
        &selected,
        &read(&core, &selected)["revision"],
        json!([mark("one")]),
    )
    .result
    .unwrap();
    let path = file(&root);
    let original = fs::read(&path).unwrap();
    for bytes in [b"{broken".to_vec(), {
        let mut value: Value = serde_json::from_slice(&original).unwrap();
        value["schemaVersion"] = json!(2);
        serde_json::to_vec(&value).unwrap()
    }] {
        fs::write(&path, &bytes).unwrap();
        assert!(call(&core, "pdf.marks.read", selected.clone())
            .error
            .is_some());
        assert!(write(&core, &selected, &saved["revision"], json!([]))
            .error
            .is_some());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    fs::write(&path, original).unwrap();
    let changed = write(&core, &selected, &saved["revision"], json!([mark("two")]))
        .result
        .unwrap();
    let latest = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    assert_eq!(
        call(&core, "pdf.marks.read", selected.clone())
            .error
            .unwrap()
            .code,
        "MISSING_PDF_MARKS"
    );
    assert!(write(&core, &selected, &changed["revision"], json!([]))
        .error
        .is_some());
    assert!(!path.exists());
    fs::write(&path, latest).unwrap();
    assert_eq!(read(&core, &selected), changed);
    core.close();
}

#[test]
fn blocked_recovery_copy_preserves_bytes_and_allows_an_explicit_retry() {
    let (root, core) = fixture(json!({}));
    let selected = target();
    let saved = write(
        &core,
        &selected,
        &read(&core, &selected)["revision"],
        json!([mark("one")]),
    )
    .result
    .unwrap();
    let path = file(&root);
    let bytes = fs::read(&path).unwrap();
    let stem = path.file_stem().unwrap().to_str().unwrap();
    let blocker = root.path().join(format!(
        "{stem}-{}.backup",
        saved["revision"].as_str().unwrap()
    ));
    fs::create_dir(&blocker).unwrap();
    assert!(
        write(&core, &selected, &saved["revision"], json!([mark("two")]))
            .error
            .is_some()
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::remove_dir(blocker).unwrap();
    assert!(
        write(&core, &selected, &saved["revision"], json!([mark("two")]))
            .error
            .is_none()
    );
    core.close();
}

#[test]
fn unreadable_original_highlights_remain_available_as_original_bytes() {
    let selected = target();
    let key = format!(
        "uterm.pdf.marks:{}/{}:{}",
        selected["directory"].as_str().unwrap(),
        selected["path"].as_str().unwrap(),
        selected["version"].as_str().unwrap()
    );
    let raw = "{original broken PDF marks";
    let (root, core) = fixture(json!({key.clone():raw}));
    let bytes = fs::read(root.path().join("snapshot-v1.json")).unwrap();
    assert_eq!(
        call(&core, "pdf.marks.read", selected.clone())
            .error
            .unwrap()
            .code,
        "CORRUPT_PDF_MARKS"
    );
    assert!(write(&core, &selected, &json!("a".repeat(64)), json!([]))
        .error
        .is_some());
    assert_eq!(
        fs::read(root.path().join("snapshot-v1.json")).unwrap(),
        bytes
    );
    assert_eq!(
        success(&core, "snapshot.read", Value::Null)["document"]["legacy"][&key],
        raw
    );
    core.close();
}

#[cfg(unix)]
#[test]
fn a_symlink_cannot_redirect_highlight_reads_or_writes() {
    let (root, core) = fixture(json!({}));
    let selected = target();
    let saved = write(
        &core,
        &selected,
        &read(&core, &selected)["revision"],
        json!([mark("one")]),
    )
    .result
    .unwrap();
    let path = file(&root);
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), b"PRIVATE_BYTES").unwrap();
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(outside.path(), &path).unwrap();
    assert!(call(&core, "pdf.marks.read", selected.clone())
        .error
        .is_some());
    assert!(write(&core, &selected, &saved["revision"], json!([]))
        .error
        .is_some());
    assert_eq!(fs::read(outside.path()).unwrap(), b"PRIVATE_BYTES");
    core.close();
}
