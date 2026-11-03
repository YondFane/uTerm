use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use uterm_core::{Core, Response};

fn execute(core: &Core, method: &str, params: Value) -> Response {
    core.execute(
        &serde_json::to_vec(
            &json!({"version":1,"id":"favorites-test","method":method,"params":params}),
        )
        .unwrap(),
    )
}
fn call(core: &Core, method: &str, params: Value) -> Value {
    let response = execute(core, method, params);
    assert!(response.error.is_none(), "{:?}", response.error);
    response.result.unwrap()
}
struct Fixture {
    _root: tempfile::TempDir,
    store: PathBuf,
    directory: PathBuf,
    repository: String,
    core: Core,
    legacy: String,
}
impl Fixture {
    fn new() -> Self {
        Self::with_old_source(true)
    }
    fn with_old_source(include: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("repository 中文");
        fs::create_dir(&directory).unwrap();
        let path = directory.to_str().unwrap();
        uterm_core::git::run(path, &["init", "--initial-branch=main"]).unwrap();
        fs::write(directory.join("tracked.txt"), "committed 中文 e\u{301}\n").unwrap();
        uterm_core::git::run(path, &["add", "--all"]).unwrap();
        uterm_core::git::run(
            path,
            &[
                "-c",
                "core.hooksPath=",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--no-gpg-sign",
                "-m",
                "favorite fixture",
            ],
        )
        .unwrap();
        let store = root.path().join("shared-state-v1");
        let core = Core::open(store.clone()).unwrap();
        let repository = call(&core, "git.references", json!({"directory":directory}))
            ["repository"]
            .as_str()
            .unwrap()
            .to_owned();
        let legacy = "[\n  \"refs/heads/main\"\n]".to_owned();
        let defaults = call(&core, "state.defaults", Value::Null);
        let mut sources = serde_json::Map::new();
        if include {
            sources.insert(format!("uterm.git.favorites:{repository}"), json!(legacy));
        }
        call(
            &core,
            "migration.import",
            json!({"workspace":defaults["workspace"], "settings":defaults["settings"], "legacy":sources}),
        );
        Self {
            _root: root,
            store,
            directory,
            repository,
            core,
            legacy,
        }
    }
    fn import(&self) -> Value {
        call(
            &self.core,
            "git.favorites.import",
            json!({"directory":self.directory}),
        )
    }
    fn read(&self) -> Value {
        call(
            &self.core,
            "git.favorites.read",
            json!({"directory":self.directory}),
        )
    }
}

#[test]
fn worktrees_share_favorites_without_reimporting_over_newer_data_and_export_current_values() {
    let fixture = Fixture::new();
    let original = fs::read(fixture.store.join("legacy-original.json")).unwrap();
    let primary = call(&fixture.core, "snapshot.read", Value::Null);
    let imported = fixture.import();
    assert_eq!(imported["references"], json!(["refs/heads/main"]));
    let head = call(
        &fixture.core,
        "git.snapshot",
        json!({"directory":fixture.directory}),
    )["head"]
        .clone();
    let tree = fixture._root.path().join("tree");
    call(
        &fixture.core,
        "git.worktrees.create",
        json!({"directory":fixture.directory,"reference":"HEAD","oid":head,"branch":"favorites-tree","path":tree}),
    );
    assert_eq!(
        call(
            &fixture.core,
            "git.favorites.read",
            json!({"directory":tree})
        ),
        imported
    );
    let next = call(
        &fixture.core,
        "git.favorites.write",
        json!({"directory":tree,"expectedRevision":imported["revision"],"references":["refs/heads/favorites-tree", "refs/heads/中文-e\u{301}"]}),
    );
    let reopened = Core::open(fixture.store.clone()).unwrap();
    assert_eq!(
        call(
            &reopened,
            "git.favorites.import",
            json!({"directory":fixture.directory,"legacy":fixture.legacy})
        ),
        next
    );
    assert_eq!(call(&reopened, "snapshot.read", Value::Null), primary);
    assert_eq!(
        fs::read(fixture.store.join("legacy-original.json")).unwrap(),
        original
    );
    let export = call(&reopened, "legacy.export", Value::Null);
    assert_eq!(
        serde_json::from_str::<Value>(
            export["values"][format!("uterm.git.favorites:{}", fixture.repository)]
                .as_str()
                .unwrap()
        )
        .unwrap(),
        next["references"]
    );
    assert_eq!(execute(&reopened, "git.favorites.write", json!({"directory":fixture.directory,"expectedRevision":imported["revision"],"references":[]})).error.unwrap().code, "CONFLICT");
    assert_eq!(fixture.read(), next);
}

#[test]
fn conflicting_and_invalid_sources_are_retained_before_explicit_acceptance() {
    let fixture = Fixture::new();
    let imported = fixture.import();
    let different = "[\r\n \"refs/heads/old-中文-e\u{301}\"\r\n]";
    assert_eq!(
        execute(
            &fixture.core,
            "git.favorites.import",
            json!({"directory":fixture.directory,"legacy":different})
        )
        .error
        .unwrap()
        .code,
        "FAVORITES_SOURCE_CONFLICT"
    );
    assert_eq!(fixture.read(), imported);
    let sources = fs::read_dir(&fixture.store)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("git-favorite-source-")
        })
        .map(|entry| fs::read(entry.path()).unwrap())
        .collect::<Vec<_>>();
    assert!(sources.contains(&different.as_bytes().to_vec()));
    assert!(sources.contains(&fixture.legacy.as_bytes().to_vec()));
    assert_eq!(
        call(
            &fixture.core,
            "git.favorites.acceptShared",
            json!({"directory":fixture.directory,"legacy":different})
        ),
        imported
    );
    let invalid = "{\r\n INVALID RECOVERY SOURCE 中文";
    assert_eq!(
        execute(
            &fixture.core,
            "git.favorites.import",
            json!({"directory":fixture.directory,"legacy":invalid})
        )
        .error
        .unwrap()
        .code,
        "INVALID_FAVORITES"
    );
    assert_eq!(fixture.read(), imported);
    assert!(fs::read_dir(&fixture.store)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with("git-favorite-source-")
            && fs::read(entry.path()).unwrap() == invalid.as_bytes()));
}

#[test]
fn corrupt_missing_and_occupied_recovery_data_never_reset_favorites() {
    let fixture = Fixture::new();
    let imported = fixture.import();
    let path = fixture.store.join("git-favorites-v1.json");
    let bytes = fs::read(&path).unwrap();
    use sha2::{Digest, Sha256};
    let backup = fixture
        .store
        .join(format!("git-favorites-{:x}.backup", Sha256::digest(&bytes)));
    fs::write(&backup, "unrelated bytes").unwrap();
    assert_eq!(execute(&fixture.core,"git.favorites.write",json!({"directory":fixture.directory,"expectedRevision":imported["revision"],"references":[]})).error.unwrap().code,"CORRUPT_STORE");
    assert_eq!(fs::read(&path).unwrap(), bytes);
    let corrupt = b"{CORRUPT FAVORITES RETAINED";
    fs::write(&path, corrupt).unwrap();
    assert_eq!(
        execute(
            &fixture.core,
            "git.favorites.import",
            json!({"directory":fixture.directory})
        )
        .error
        .unwrap()
        .code,
        "CORRUPT_FAVORITES"
    );
    assert_eq!(fs::read(&path).unwrap(), corrupt);
    fs::remove_file(&path).unwrap();
    assert_eq!(
        execute(
            &fixture.core,
            "git.favorites.import",
            json!({"directory":fixture.directory})
        )
        .error
        .unwrap()
        .code,
        "MISSING_FAVORITES"
    );
    assert_eq!(fs::read(&backup).unwrap(), b"unrelated bytes");
}

#[test]
fn favorite_requests_reject_forged_identities_and_invalid_references() {
    let fixture = Fixture::new();
    let imported = fixture.import();
    for params in [
        json!({"directory":fixture.directory,"repository":"forged"}),
        json!({"directory":fixture.directory,"expectedRevision":"ignored"}),
    ] {
        assert_eq!(
            execute(&fixture.core, "git.favorites.read", params)
                .error
                .unwrap()
                .code,
            "INVALID_ARGUMENT"
        );
    }
    for references in [
        json!(["refs/heads/main", "refs/heads/main"]),
        json!(["../other"]),
        json!(["refs/heads/main\nrefs/heads/other"]),
    ] {
        assert_eq!(execute(&fixture.core,"git.favorites.write",json!({"directory":fixture.directory,"expectedRevision":imported["revision"],"references":references})).error.unwrap().code,"INVALID_FAVORITES");
    }
    assert_eq!(fixture.read(), imported);
}

#[cfg(unix)]
struct WriteBlocker(PathBuf);
#[cfg(unix)]
impl WriteBlocker {
    fn new(path: &std::path::Path) -> Self {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o500)).unwrap();
        Self(path.into())
    }
}
#[cfg(unix)]
impl Drop for WriteBlocker {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700)).unwrap();
    }
}
#[cfg(windows)]
struct WriteBlocker {
    _file: std::fs::File,
}
#[cfg(windows)]
impl WriteBlocker {
    fn new(path: &std::path::Path) -> Self {
        use std::os::windows::fs::OpenOptionsExt;
        Self {
            _file: fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(path.join("git-favorites-v1.json"))
                .unwrap(),
        }
    }
}
#[test]
#[ignore = "Run explicitly with pnpm test:core; use an unprivileged Unix user"]
fn filesystem_failure_preserves_git_favorites_and_allows_explicit_retry() {
    let fixture = Fixture::new();
    let imported = fixture.import();
    let path = fixture.store.join("git-favorites-v1.json");
    let before = fs::read(&path).unwrap();
    let original = fs::read(fixture.store.join("legacy-original.json")).unwrap();
    let blocker = WriteBlocker::new(&fixture.store);
    assert_eq!(execute(&fixture.core,"git.favorites.write",json!({"directory":fixture.directory,"expectedRevision":imported["revision"],"references":[]})).error.unwrap().code,"IO");
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(fixture.read(), imported);
    assert_eq!(
        fs::read(fixture.store.join("legacy-original.json")).unwrap(),
        original
    );
    drop(blocker);
    let saved = call(
        &fixture.core,
        "git.favorites.write",
        json!({"directory":fixture.directory,"expectedRevision":imported["revision"],"references":[]}),
    );
    assert_eq!(saved["references"], json!([]));
    let reopened = Core::open(fixture.store.clone()).unwrap();
    assert_eq!(
        call(
            &reopened,
            "git.favorites.import",
            json!({"directory":fixture.directory,"legacy":fixture.legacy})
        ),
        saved
    );
    let damaged = b"{interrupted favorite store before restore";
    fs::write(&path, damaged).unwrap();
    let revision = digest(&before);
    let damaged_revision = digest(damaged);
    let blocker = WriteBlocker::new(&fixture.store);
    assert_eq!(
        execute(
            &fixture.core,
            "git.favorites.recovery.restore",
            json!({"revision":revision,"expectedRevision":damaged_revision,"expectedMissing":false})
        )
        .error
        .unwrap()
        .code,
        "IO"
    );
    assert_eq!(fs::read(&path).unwrap(), damaged);
    assert_eq!(
        fs::read(fixture.store.join("legacy-original.json")).unwrap(),
        original
    );
    drop(blocker);
    call(
        &fixture.core,
        "git.favorites.recovery.restore",
        json!({"revision":revision,"expectedRevision":damaged_revision,"expectedMissing":false}),
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(
        fs::read(
            fixture
                .store
                .join(format!("git-favorites-{damaged_revision}.damaged"))
        )
        .unwrap(),
        damaged
    );
}

#[test]
fn a_later_webview_import_exports_the_actual_old_client_key_as_well_as_canonical_identity() {
    let fixture = Fixture::with_old_source(false);
    let imported = call(
        &fixture.core,
        "git.favorites.import",
        json!({"directory":fixture.directory,"legacy":fixture.legacy}),
    );
    #[cfg(windows)]
    {
        assert!(imported["repository"]
            .as_str()
            .unwrap()
            .starts_with(r"\\?\"));
        assert!(!fixture.repository.starts_with(r"\\?\"));
    }
    call(
        &fixture.core,
        "git.favorites.write",
        json!({"directory":fixture.directory,"expectedRevision":imported["revision"],"references":[]}),
    );
    let current = call(&fixture.core, "legacy.export", Value::Null);
    assert_eq!(
        serde_json::from_str::<Value>(
            current["values"][format!("uterm.git.favorites:{}", fixture.repository)]
                .as_str()
                .unwrap()
        )
        .unwrap(),
        json!([])
    );
    assert_eq!(
        serde_json::from_str::<Value>(
            current["values"][format!(
                "uterm.git.favorites:{}",
                imported["repository"].as_str().unwrap()
            )]
            .as_str()
            .unwrap()
        )
        .unwrap(),
        json!([])
    );
    assert_eq!(
        call(&fixture.core, "snapshot.read", Value::Null)["document"]["legacy"],
        json!({})
    );
}

fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn recovery_preview_restore_and_missing_installation_preserve_current_and_damaged_bytes() {
    let fixture = Fixture::new();
    let first = fixture.import();
    let path = fixture.store.join("git-favorites-v1.json");
    let first_bytes = fs::read(&path).unwrap();
    let first_revision = digest(&first_bytes);
    let original = fs::read(fixture.store.join("legacy-original.json")).unwrap();
    call(
        &fixture.core,
        "git.favorites.write",
        json!({"directory":fixture.directory,"expectedRevision":first["revision"],"references":["refs/heads/recovered-中文-e\u{301}"]}),
    );
    let second_bytes = fs::read(&path).unwrap();
    let second_revision = digest(&second_bytes);
    let catalog = call(&fixture.core, "git.favorites.recovery.list", Value::Null);
    assert_eq!(catalog["currentRevision"], second_revision);
    assert!(catalog["backups"]
        .as_array()
        .unwrap()
        .contains(&json!(first_revision)));
    let preview = call(
        &fixture.core,
        "git.favorites.recovery.preview",
        json!({"revision":first_revision}),
    );
    assert_eq!(fs::read(&path).unwrap(), second_bytes);
    assert_eq!(preview["revision"], first_revision);
    call(
        &fixture.core,
        "git.favorites.recovery.restore",
        json!({"revision":first_revision,"expectedRevision":second_revision,"expectedMissing":false}),
    );
    assert_eq!(fs::read(&path).unwrap(), first_bytes);
    assert_eq!(
        fs::read(
            fixture
                .store
                .join(format!("git-favorites-{second_revision}.backup"))
        )
        .unwrap(),
        second_bytes
    );
    assert_eq!(
        call(
            &fixture.core,
            "git.favorites.recovery.source",
            json!({"revision":first["sourceDigest"]})
        ),
        fixture.legacy
    );
    let damaged = b"{CORRUPT FAVORITE DATA RETAINED\r\n";
    fs::write(&path, damaged).unwrap();
    let damaged_revision = digest(damaged);
    for params in [
        json!({"revision":second_revision,"expectedRevision":first_revision,"expectedMissing":false}),
        json!({"revision":second_revision,"expectedRevision":null,"expectedMissing":true}),
    ] {
        assert_eq!(
            execute(&fixture.core, "git.favorites.recovery.restore", params)
                .error
                .unwrap()
                .code,
            "CONFLICT"
        );
        assert_eq!(fs::read(&path).unwrap(), damaged);
    }
    assert_eq!(
        execute(
            &fixture.core,
            "git.favorites.recovery.restore",
            json!({"revision":second_revision,"expectedRevision":null,"expectedMissing":false})
        )
        .error
        .unwrap()
        .code,
        "INVALID_ARGUMENT"
    );
    let restored = call(
        &fixture.core,
        "git.favorites.recovery.restore",
        json!({"revision":second_revision,"expectedRevision":damaged_revision,"expectedMissing":false}),
    );
    assert_eq!(restored["revision"], second_revision);
    assert_eq!(fs::read(&path).unwrap(), second_bytes);
    assert_eq!(
        fs::read(
            fixture
                .store
                .join(format!("git-favorites-{damaged_revision}.damaged"))
        )
        .unwrap(),
        damaged
    );
    fs::remove_file(&path).unwrap();
    assert!(
        call(&fixture.core, "git.favorites.recovery.list", Value::Null)["currentRevision"]
            .is_null()
    );
    assert_eq!(
        execute(
            &fixture.core,
            "git.favorites.import",
            json!({"directory":fixture.directory})
        )
        .error
        .unwrap()
        .code,
        "MISSING_FAVORITES"
    );
    call(
        &fixture.core,
        "git.favorites.recovery.restore",
        json!({"revision":first_revision,"expectedRevision":null,"expectedMissing":true}),
    );
    assert_eq!(fs::read(&path).unwrap(), first_bytes);
    assert_eq!(
        execute(
            &fixture.core,
            "git.favorites.recovery.restore",
            json!({"revision":second_revision,"expectedRevision":null,"expectedMissing":true})
        )
        .error
        .unwrap()
        .code,
        "CONFLICT"
    );
    assert_eq!(fs::read(&path).unwrap(), first_bytes);
    assert_eq!(
        fs::read(fixture.store.join("legacy-original.json")).unwrap(),
        original
    );
    let reopened = Core::open(fixture.store.clone()).unwrap();
    assert_eq!(
        call(
            &reopened,
            "git.favorites.read",
            json!({"directory":fixture.directory})
        ),
        first
    );
}

#[test]
fn recovery_rejects_forged_checksums_unknown_fields_and_occupied_damaged_copies() {
    let fixture = Fixture::new();
    let imported = fixture.import();
    let path = fixture.store.join("git-favorites-v1.json");
    let bytes = fs::read(&path).unwrap();
    let revision = digest(&bytes);
    let backup = fixture
        .store
        .join(format!("git-favorites-{revision}.backup"));
    fs::write(&backup, b"{\"schemaVersion\":1,\"repositories\":{}}").unwrap();
    assert_eq!(
        execute(
            &fixture.core,
            "git.favorites.recovery.preview",
            json!({"revision":revision})
        )
        .error
        .unwrap()
        .code,
        "CORRUPT_FAVORITES"
    );
    assert!(
        !call(&fixture.core, "git.favorites.recovery.list", Value::Null)["backups"]
            .as_array()
            .unwrap()
            .contains(&json!(revision))
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::write(&backup, &bytes).unwrap();
    for params in [
        json!({"revision":"../snapshot-v1"}),
        json!({"revision":revision,"directory":fixture.directory}),
    ] {
        assert_eq!(
            execute(&fixture.core, "git.favorites.recovery.preview", params)
                .error
                .unwrap()
                .code,
            "INVALID_ARGUMENT"
        );
    }
    assert_eq!(
        execute(
            &fixture.core,
            "git.favorites.recovery.list",
            json!({"directory":fixture.directory})
        )
        .error
        .unwrap()
        .code,
        "INVALID_ARGUMENT"
    );
    let source = fixture.store.join(format!(
        "git-favorite-source-{}.json",
        imported["sourceDigest"].as_str().unwrap()
    ));
    fs::write(&source, b"unrelated source bytes").unwrap();
    assert_eq!(
        execute(
            &fixture.core,
            "git.favorites.recovery.source",
            json!({"revision":imported["sourceDigest"]})
        )
        .error
        .unwrap()
        .code,
        "CORRUPT_FAVORITES"
    );
    assert_eq!(fs::read(&source).unwrap(), b"unrelated source bytes");
    let damaged = b"{interrupted favorites write";
    fs::write(&path, damaged).unwrap();
    let damaged_revision = digest(damaged);
    let occupied = fixture
        .store
        .join(format!("git-favorites-{damaged_revision}.damaged"));
    fs::write(&occupied, b"retained unrelated data").unwrap();
    assert_eq!(
        execute(
            &fixture.core,
            "git.favorites.recovery.restore",
            json!({"revision":revision,"expectedRevision":damaged_revision,"expectedMissing":false})
        )
        .error
        .unwrap()
        .code,
        "CORRUPT_STORE"
    );
    assert_eq!(fs::read(&path).unwrap(), damaged);
    assert_eq!(fs::read(&occupied).unwrap(), b"retained unrelated data");
    assert_eq!(fs::read(&backup).unwrap(), bytes);
}

#[test]
fn global_recovery_restores_the_selected_snapshot_for_every_repository_and_keeps_undo() {
    let fixture = Fixture::new();
    let first = fixture.import();
    let other = fixture._root.path().join("other-repository");
    uterm_core::git::run(
        fixture.directory.to_str().unwrap(),
        &[
            "clone",
            "--no-hardlinks",
            "--",
            fixture.directory.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    )
    .unwrap();
    let peer = call(
        &fixture.core,
        "git.favorites.import",
        json!({"directory":other,"legacy":"[\"refs/heads/peer\"]"}),
    );
    let path = fixture.store.join("git-favorites-v1.json");
    let together = fs::read(&path).unwrap();
    let together_revision = digest(&together);
    call(
        &fixture.core,
        "git.favorites.write",
        json!({"directory":fixture.directory,"expectedRevision":first["revision"],"references":[]}),
    );
    let changed = fs::read(&path).unwrap();
    let changed_revision = digest(&changed);
    let restored = call(
        &fixture.core,
        "git.favorites.recovery.restore",
        json!({"revision":together_revision,"expectedRevision":changed_revision,"expectedMissing":false}),
    );
    assert_eq!(
        restored["document"]["repositories"]
            .as_object()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(fixture.read(), first);
    assert_eq!(
        call(
            &fixture.core,
            "git.favorites.read",
            json!({"directory":other})
        ),
        peer
    );
    assert_eq!(fs::read(&path).unwrap(), together);
    assert_eq!(
        fs::read(
            fixture
                .store
                .join(format!("git-favorites-{changed_revision}.backup"))
        )
        .unwrap(),
        changed
    );
}

#[test]
fn restoration_keeps_its_selected_copy_and_immediate_undo_within_the_valid_backup_limit() {
    let fixture = Fixture::new();
    let mut current = fixture.import();
    for index in 0..14 {
        current = call(
            &fixture.core,
            "git.favorites.write",
            json!({"directory":fixture.directory,"expectedRevision":current["revision"],"references":[format!("refs/heads/iteration-{index}")]}),
        );
    }
    let catalog = call(&fixture.core, "git.favorites.recovery.list", Value::Null);
    assert_eq!(catalog["backups"].as_array().unwrap().len(), 8);
    let previous = catalog["currentRevision"].as_str().unwrap();
    let selected = catalog["backups"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .as_str()
        .unwrap();
    let unrelated = fixture
        .store
        .join(format!("git-favorites-{}.backup", "0".repeat(64)));
    fs::write(
        &unrelated,
        b"invalid copy retained for manual investigation",
    )
    .unwrap();
    call(
        &fixture.core,
        "git.favorites.recovery.restore",
        json!({"revision":selected,"expectedRevision":previous,"expectedMissing":false}),
    );
    let after = call(&fixture.core, "git.favorites.recovery.list", Value::Null);
    assert_eq!(after["backups"].as_array().unwrap().len(), 8);
    assert!(after["backups"]
        .as_array()
        .unwrap()
        .contains(&json!(selected)));
    assert!(after["backups"]
        .as_array()
        .unwrap()
        .contains(&json!(previous)));
    assert_eq!(
        fs::read(&unrelated).unwrap(),
        b"invalid copy retained for manual investigation"
    );
    assert_eq!(
        call(
            &fixture.core,
            "git.favorites.recovery.source",
            json!({"revision":current["sourceDigest"]})
        ),
        fixture.legacy
    );
}
