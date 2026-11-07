use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path};
use uterm_core::{Core, CoreError};

fn call(core: &Core, method: &str, params: Value) -> Result<Value, CoreError> {
    let reply = core.execute(
        &serde_json::to_vec(
            &json!({"version":1,"id":"rollback-test","method":method,"params":params}),
        )
        .unwrap(),
    );
    match reply.error {
        Some(error) => Err(error),
        None => Ok(reply.result.unwrap()),
    }
}
fn files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(root)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().to_string_lossy().into_owned(),
                fs::read(entry.path()).unwrap(),
            )
        })
        .collect()
}
fn draft(path: &str, text: &str) -> Value {
    json!({"directory":"/temporary/项目","path":path,"kind":"text","text":text,"saved":"saved\r\n","version":"a".repeat(64),"line_ending":"\r\n","bom":true})
}

#[test]
fn rollback_archive_keeps_latest_all_drafts_and_never_silently_resets_or_writes() {
    let evidence = std::env::var_os("UTERM_ROLLBACK_EXPORT_REPORT").map(std::path::PathBuf::from);
    if let Some(path) = &evidence {
        fs::write(path, b"{\"passed\":false}").unwrap();
    }
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().into()).unwrap();
    let defaults = call(&core, "state.defaults", Value::Null).unwrap();
    let original = format!(" \n{}\n", draft("a.txt", "ORIGINAL 未保存\r\n"));
    let snapshot = call(&core, "migration.import", json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{"uterm.desktop.editorDraft.v1":original,"uterm.fake.credential.reference":"fixture-reference-only"}})).unwrap();
    let initial = call(&core, "editor.drafts.import", json!({})).unwrap();
    let updated = call(
        &core,
        "editor.drafts.put",
        json!({"expectedRevision":initial["revision"],"draft":draft("a.txt", "LATEST 中文 é\r\n")}),
    )
    .unwrap();
    let expected = json!({"expectedRevision":snapshot["revision"],"expectedDraftRevision":updated["revision"]});
    let before = files(root.path());
    let archive = call(&core, "rollback.export", expected.clone()).unwrap();
    assert_eq!(archive["editor"], updated);
    assert_eq!(archive["snapshot"], snapshot);
    assert_eq!(
        archive["snapshot"]["document"]["legacy"]["uterm.desktop.editorDraft.v1"],
        original
    );
    let current: Value = serde_json::from_str(
        archive["legacyValues"]["uterm.desktop.editorDraft.v1"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(current, draft("a.txt", "LATEST 中文 é\r\n"));
    assert_eq!(archive["automaticRestoreAllowed"], false);
    assert_eq!(
        files(root.path()),
        before,
        "Read-only export changed canonical/source/backup bytes"
    );
    assert_eq!(
        call(&core, "rollback.export", expected.clone()).unwrap(),
        archive
    );
    assert_eq!(
        call(
            &core,
            "rollback.export",
            json!({"expectedRevision":"stale"})
        )
        .unwrap_err()
        .code,
        "CONFLICT"
    );
    assert_eq!(call(&core, "rollback.export", json!({"expectedRevision":snapshot["revision"],"expectedDraftRevision":initial["revision"]})).unwrap_err().code, "CONFLICT");
    assert!(call(
        &core,
        "rollback.export",
        json!({"expectedRevision":snapshot["revision"],"expectedDraftRevision":42})
    )
    .is_err());
    assert!(call(
        &core,
        "rollback.export",
        json!({"expectedRevision":snapshot["revision"],"unknown":true})
    )
    .is_err());
    assert_eq!(files(root.path()), before);

    let multiple = call(&core, "editor.drafts.put", json!({"expectedRevision":updated["revision"],"draft":draft("b.txt", "SECOND draft 🧪\r\n")})).unwrap();
    let archive = call(&core, "rollback.export", json!({"expectedRevision":snapshot["revision"],"expectedDraftRevision":multiple["revision"]})).unwrap();
    assert_eq!(archive["legacyRequiresDraftChoice"], true);
    assert!(archive["legacyValues"]
        .get("uterm.desktop.editorDraft.v1")
        .is_none());
    assert_eq!(
        archive["legacyDraftCandidates"].as_array().unwrap().len(),
        2
    );
    for (index, candidate) in archive["legacyDraftCandidates"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let parsed: Value = serde_json::from_str(candidate["value"].as_str().unwrap()).unwrap();
        assert_eq!(parsed, multiple["document"]["drafts"][index]);
    }
    call(&core, "editor.drafts.remove", json!({"expectedRevision":multiple["revision"],"directory":"/temporary/项目","path":"a.txt"})).unwrap();
    let remaining = call(&core, "editor.drafts.read", Value::Null).unwrap();
    call(&core, "editor.drafts.remove", json!({"expectedRevision":remaining["revision"],"directory":"/temporary/项目","path":"b.txt"})).unwrap();
    let empty = call(
        &core,
        "rollback.export",
        json!({"expectedRevision":snapshot["revision"]}),
    )
    .unwrap();
    assert!(
        empty["legacyValues"]
            .get("uterm.desktop.editorDraft.v1")
            .is_none(),
        "Cleared drafts were resurrected"
    );
    assert_eq!(
        empty["snapshot"]["document"]["legacy"]["uterm.desktop.editorDraft.v1"],
        original
    );
    let drafts_path = root.path().join("editor-drafts-v1.json");
    let intact = fs::read(&drafts_path).unwrap();
    for broken in [
        b"{interrupted draft".as_slice(),
        b"{\"schemaVersion\":999,\"sourceDigest\":null,\"drafts\":[]}".as_slice(),
    ] {
        fs::write(&drafts_path, broken).unwrap();
        let before = files(root.path());
        assert!(call(
            &core,
            "rollback.export",
            json!({"expectedRevision":snapshot["revision"]})
        )
        .is_err());
        assert_eq!(files(root.path()), before);
    }
    fs::write(&drafts_path, intact).unwrap();
    let writer = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join("writer.lock"))
        .unwrap();
    writer.try_lock().unwrap();
    assert_eq!(
        call(
            &core,
            "rollback.export",
            json!({"expectedRevision":snapshot["revision"]})
        )
        .unwrap_err()
        .code,
        "WRITER_BUSY"
    );
    drop(writer);
    assert!(call(
        &core,
        "rollback.export",
        json!({"expectedRevision":snapshot["revision"]})
    )
    .is_ok());
    if let Some(path) = evidence {
        let tested = String::from_utf8(
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_owned();
        let dirty = !std::process::Command::new("git")
            .args(["diff", "--quiet", "HEAD"])
            .status()
            .unwrap()
            .success();
        let rust = String::from_utf8(
            std::process::Command::new("rustc")
                .arg("--version")
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        fs::write(path, serde_json::to_vec_pretty(&json!({"passed":true,"sourceTreeDirty":dirty,"rust":rust.trim(),"sourceHeadSHA":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_|tested.clone()),"testedMergeSHA":tested,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"productionDataAccess":false,"actualApplicationUpgradeExecuted":false,"scenarios":["latest draft bytes/BOM/CRLF/Unicode","original source retained","all multi-document drafts retained with explicit choice","deleted drafts not resurrected","snapshot/draft stale revision rejection","malformed arguments","corrupt/unsupported draft store retained","writer contention and retry","read-only/idempotent export"]})).unwrap()).unwrap();
    }
}
