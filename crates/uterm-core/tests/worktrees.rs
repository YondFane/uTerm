use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};
use uterm_core::{Core, Response};
use utermd_local::daemon::{Client, Operation, Reply, SessionSpec};

fn execute(core: &Core, method: &str, params: Value) -> Response {
    core.execute(
        &serde_json::to_vec(
            &json!({"version":1,"id":"worktree-qa","method":method,"params":params}),
        )
        .unwrap(),
    )
}
fn call(core: &Core, method: &str, params: Value) -> Value {
    let reply = execute(core, method, params);
    assert!(reply.error.is_none(), "{:?}", reply.error);
    reply.result.unwrap()
}
struct Fixture {
    root: tempfile::TempDir,
    app: PathBuf,
    store: PathBuf,
    core: Core,
    tree: PathBuf,
    tree_id: String,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("app");
        let store = app.join("shared-state-v1");
        let repository = root.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let directory = repository.to_str().unwrap();
        uterm_core::git::run(directory, &["init", "--initial-branch=main"]).unwrap();
        fs::write(repository.join("tracked.txt"), "committed 中文 e\u{301}\n").unwrap();
        uterm_core::git::run(directory, &["add", "--all"]).unwrap();
        uterm_core::git::run(
            directory,
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
                "isolated deletion fixture",
            ],
        )
        .unwrap();
        let core = Core::open(store.clone()).unwrap();
        let head = call(&core, "git.snapshot", json!({"directory": directory}))["head"].clone();
        let defaults = call(&core, "state.defaults", Value::Null);
        let imported = call(
            &core,
            "migration.import",
            json!({"workspace":defaults["workspace"], "settings":defaults["settings"], "legacy":{}}),
        );
        let project = call(
            &core,
            "project.open",
            json!({"id":"project", "name":"Repository", "workspaceId":"local", "directory":directory, "expectedRevision":imported["revision"]}),
        );
        let tree = root.path().join("tree-中文");
        call(
            &core,
            "git.worktrees.create",
            json!({"directory":directory, "reference":"HEAD", "oid":head, "branch":"qa/tree", "path":tree}),
        );
        let refreshed = call(
            &core,
            "project.worktrees.refresh",
            json!({"id":"project", "expectedRevision":project["revision"]}),
        );
        let tree_id = refreshed["document"]["workspace"]["projects"][0]["worktrees"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        call(
            &core,
            "project.select",
            json!({"id":"project", "worktreeId":tree_id, "expectedRevision":refreshed["revision"]}),
        );
        Self {
            root,
            app,
            store,
            core,
            tree,
            tree_id,
        }
    }
    fn snapshot(&self) -> Value {
        call(&self.core, "snapshot.read", Value::Null)
    }
    fn deletion(&self) -> Value {
        json!({"id":"project", "worktreeId":self.tree_id, "expectedRevision":self.snapshot()["revision"]})
    }
}

#[test]
fn deletion_refuses_stale_arguments_dirty_data_and_saved_session_references() {
    let fixture = Fixture::new();
    let before = fixture.snapshot();
    let source = fs::read(fixture.store.join("legacy-original.json")).unwrap();
    let mut request = fixture.deletion();
    request["expectedRevision"] = json!("stale");
    assert_eq!(
        execute(&fixture.core, "project.worktrees.delete", request)
            .error
            .unwrap()
            .code,
        "CONFLICT"
    );
    let mut forged = fixture.deletion();
    forged["path"] = json!(fixture.root.path());
    assert_eq!(
        execute(&fixture.core, "project.worktrees.delete", forged)
            .error
            .unwrap()
            .code,
        "INVALID_ARGUMENT"
    );
    let dirty = fixture.tree.join("retain.txt");
    let bytes = "unsaved 中文 e\u{301}\r\n".as_bytes();
    fs::write(&dirty, bytes).unwrap();
    assert_eq!(
        execute(
            &fixture.core,
            "project.worktrees.delete",
            fixture.deletion()
        )
        .error
        .unwrap()
        .code,
        "GIT_ERROR"
    );
    assert_eq!(fs::read(&dirty).unwrap(), bytes);
    assert_eq!(fixture.snapshot(), before);
    fs::remove_file(dirty).unwrap();
    let referenced = call(
        &fixture.core,
        "session.create",
        json!({"id":"retained-session", "name":"Retain", "expectedRevision":before["revision"]}),
    );
    assert_eq!(
        execute(
            &fixture.core,
            "project.worktrees.delete",
            fixture.deletion()
        )
        .error
        .unwrap()
        .code,
        "WORKTREE_IN_USE"
    );
    assert!(fixture.tree.is_dir());
    assert_eq!(fixture.snapshot(), referenced);
    call(
        &fixture.core,
        "session.remove",
        json!({"id":"retained-session", "expectedRevision":referenced["revision"]}),
    );
    let deleted = call(
        &fixture.core,
        "project.worktrees.delete",
        fixture.deletion(),
    );
    assert!(!fixture.tree.exists());
    assert!(deleted["document"]["workspace"]["projects"][0]["worktrees"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(deleted["document"]["workspace"]["selectedWorktree"].is_null());
    assert_eq!(
        fs::read(fixture.store.join("legacy-original.json")).unwrap(),
        source
    );
    let reopened = Core::open(fixture.store.clone()).unwrap();
    assert_eq!(call(&reopened, "snapshot.read", Value::Null), deleted);
}

struct HostCleanup(PathBuf);
impl Drop for HostCleanup {
    fn drop(&mut self) {
        if let Ok(client) = Client::connect(&self.0) {
            if let Ok(Reply::HostStatus(status)) = client.request(Operation::HostStatus) {
                for session in status.sessions {
                    let _ = client.request(Operation::Close {
                        id: session.spec.id,
                        generation: session.generation,
                    });
                }
            }
            let _ = client.request(Operation::ShutdownIfIdle);
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.0.join("endpoint.json").exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}
fn helper() -> PathBuf {
    let name = if cfg!(windows) {
        "utermd-local.exe"
    } else {
        "utermd-local"
    };
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../utermd-local/target"))
        .join("debug")
        .join(name)
        .canonicalize()
        .expect("Build helper with pnpm test:core")
}

#[test]
fn deletion_checks_live_host_sessions_without_restarting_or_closing_them() {
    let fixture = Fixture::new();
    let host_root = fixture.app.join("local-daemon-v1");
    let nested = fixture.tree.join("nested");
    fs::create_dir(&nested).unwrap();
    let cleanup = HostCleanup(host_root.clone());
    let client = utermd_local::daemon::ensure_running(&host_root, &helper()).unwrap();
    let Reply::Opened { .. } = client
        .request(Operation::Open {
            spec: SessionSpec {
                id: "orphan-qa".into(),
                directory: nested,
                shell: "default".into(),
                agent: None,
                ssh: None,
            },
            rows: 24,
            cols: 80,
        })
        .unwrap()
    else {
        panic!("Expected real shell")
    };
    let Reply::HostStatus(before) = client.request(Operation::HostStatus).unwrap() else {
        panic!("Expected status")
    };
    assert!(before.sessions.iter().any(|session| session.running));
    assert_eq!(
        execute(
            &fixture.core,
            "project.worktrees.delete",
            fixture.deletion()
        )
        .error
        .unwrap()
        .code,
        "WORKTREE_IN_USE"
    );
    let Reply::HostStatus(after) = client.request(Operation::HostStatus).unwrap() else {
        panic!("Expected status")
    };
    assert_eq!(after.pid, before.pid);
    assert!(after
        .sessions
        .iter()
        .any(|session| session.spec.id == "orphan-qa" && session.running));
    assert!(fixture.tree.is_dir());
    drop(cleanup);
    assert!(!host_root.join("endpoint.json").exists());
    call(
        &fixture.core,
        "project.worktrees.delete",
        fixture.deletion(),
    );
    assert!(!fixture.tree.exists());
}

#[test]
fn an_unavailable_host_never_allows_unverified_worktree_deletion() {
    let fixture = Fixture::new();
    let before = fixture.snapshot();
    let original = fs::read(fixture.tree.join("tracked.txt")).unwrap();
    let host_root = fixture.app.join("local-daemon-v1");
    fs::create_dir(&host_root).unwrap();
    fs::write(host_root.join("endpoint.json"), "{invalid endpoint fixture").unwrap();
    assert_eq!(
        execute(
            &fixture.core,
            "project.worktrees.delete",
            fixture.deletion()
        )
        .error
        .unwrap()
        .code,
        "HOST_UNAVAILABLE"
    );
    assert!(fixture.tree.is_dir());
    assert_eq!(fixture.snapshot(), before);
    assert_eq!(
        fs::read(fixture.tree.join("tracked.txt")).unwrap(),
        original
    );
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
struct WriteBlocker(std::fs::File);
#[cfg(windows)]
impl WriteBlocker {
    fn new(path: &std::path::Path) -> Self {
        use std::os::windows::fs::OpenOptionsExt;
        Self(
            fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(path.join("snapshot-v1.json"))
                .unwrap(),
        )
    }
}

#[test]
#[ignore = "Run explicitly with pnpm test:core; use an unprivileged user on Unix"]
fn metadata_failure_after_git_removal_retains_snapshot_and_allows_explicit_refresh() {
    let fixture = Fixture::new();
    let request = fixture.deletion();
    let bytes = fs::read(fixture.store.join("snapshot-v1.json")).unwrap();
    let source = fs::read(fixture.store.join("legacy-original.json")).unwrap();
    let blocker = WriteBlocker::new(&fixture.store);
    let failed = execute(&fixture.core, "project.worktrees.delete", request.clone());
    drop(blocker);
    assert_eq!(
        failed.error.unwrap().code,
        "WORKTREE_SYNC",
        "Use an unprivileged user on Unix"
    );
    assert!(!fixture.tree.exists());
    assert_eq!(
        fs::read(fixture.store.join("snapshot-v1.json")).unwrap(),
        bytes
    );
    assert_eq!(
        fs::read(fixture.store.join("legacy-original.json")).unwrap(),
        source
    );
    let refreshed = call(
        &fixture.core,
        "project.worktrees.refresh",
        json!({"id":"project", "expectedRevision":request["expectedRevision"]}),
    );
    assert!(
        refreshed["document"]["workspace"]["projects"][0]["worktrees"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
