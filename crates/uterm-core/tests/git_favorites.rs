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
