use std::sync::{Arc, Mutex};
use tauri::Manager;

#[derive(Default)]
struct State {
    pending: usize,
    exiting: bool,
}

#[derive(Default, Clone)]
pub struct ContentOperations(Arc<Mutex<State>>);

pub struct Operation(Arc<Mutex<State>>);

impl ContentOperations {
    fn begin_request(&self, request: &str) -> Result<Option<Operation>, String> {
        #[derive(serde::Deserialize)]
        struct Header {
            method: String,
        }
        let read = serde_json::from_str::<Header>(request).is_ok_and(|header| {
            matches!(
                header.method.as_str(),
                "contract.info"
                    | "state.defaults"
                    | "snapshot.read"
                    | "pdf.marks.read"
                    | "snapshot.view"
                    | "session.entries"
                    | "project.context"
                    | "editor.drafts.read"
                    | "editor.drafts.list"
                    | "editor.drafts.document"
                    | "editor.drafts.recovery.list"
                    | "editor.drafts.recovery.preview"
                    | "git.favorites.read"
                    | "git.favorites.recovery.list"
                    | "git.favorites.recovery.preview"
                    | "git.favorites.recovery.source"
                    | "files.list"
                    | "files.read"
                    | "files.search"
                    | "git.branch"
                    | "git.branches"
                    | "git.remoteBranches"
                    | "git.fileStatus"
                    | "git.snapshot"
                    | "git.diff"
                    | "git.history"
                    | "git.files"
                    | "git.references"
                    | "git.workingComparison"
                    | "git.worktrees.list"
                    | "python.configuration"
                    | "python.interpreters"
                    | "python.project"
                    | "python.path.validate"
                    | "python.tasks"
                    | "java.components.status"
                    | "java.components.read"
                    | "java.configuration"
                    | "java.jdks.list"
                    | "java.project"
                    | "java.tasks"
            )
        });
        if !read {
            return self.begin().map(Some);
        }
        if self.0.lock().unwrap_or_else(|e| e.into_inner()).exiting {
            return Err("CLOSED: Application is exiting; operation was not started".into());
        }
        Ok(None)
    }
    fn begin(&self) -> Result<Operation, String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.exiting {
            return Err("CLOSED: Application is exiting; operation was not started".into());
        }
        state.pending = state.pending.checked_add(1).ok_or("Too many operations")?;
        Ok(Operation(self.0.clone()))
    }

    pub fn prepare_exit(&self) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.pending != 0 {
            return false;
        }
        state.exiting = true;
        true
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).pending -= 1;
    }
}

pub fn begin(app: &tauri::AppHandle) -> Result<Operation, String> {
    app.state::<ContentOperations>().begin()
}
pub fn begin_request(app: &tauri::AppHandle, request: &str) -> Result<Option<Operation>, String> {
    app.state::<ContentOperations>().begin_request(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn pending_real_snapshot_reply_does_not_refuse_quit_but_a_committed_write_still_does() {
        use serde_json::json;
        let root = tempfile::tempdir().unwrap();
        let core = Arc::new(uterm_core::Core::open(root.path().join("shared-state-v1")).unwrap());
        let execute = |method: &str, params| {
            core.execute(
                &serde_json::to_vec(
                    &json!({"version":1,"id":"fixture","method":method,"params":params}),
                )
                .unwrap(),
            )
        };
        let defaults = execute("state.defaults", serde_json::Value::Null)
            .result
            .unwrap();
        let imported = execute(
            "migration.import",
            json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}}),
        );
        assert!(imported.error.is_none());
        for write in [false, true] {
            let state = ContentOperations::default();
            let request = if write {
                json!({"version":1,"id":"pending","method":"settings.patch","params":{"expectedRevision":imported.result.as_ref().unwrap()["revision"],"patch":{"fontSize":18}}})
            } else { json!({"version":1,"id":"pending","method":"snapshot.read"}) }.to_string();
            let operation = state.begin_request(&request).unwrap();
            let (send, receive) = mpsc::channel();
            let (release, wait) = mpsc::channel();
            let worker_core = core.clone();
            let worker = std::thread::spawn(move || {
                let _operation = operation;
                send.send(worker_core.execute(request.as_bytes())).unwrap();
                wait.recv().unwrap();
            });
            let reply = receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert!(reply.error.is_none(), "{:?}", reply.error);
            assert_eq!(state.prepare_exit(), !write);
            if write {
                assert!(state
                    .begin_request(r#"{"method":"future.write"}"#)
                    .unwrap()
                    .is_some());
                assert_eq!(
                    execute("snapshot.read", serde_json::Value::Null)
                        .result
                        .unwrap()["document"]["settings"]["fontSize"],
                    18
                );
            } else {
                assert!(state
                    .begin_request(r#"{"method":"settings.patch"}"#)
                    .is_err());
            }
            release.send(()).unwrap();
            worker.join().unwrap();
            assert!(state.prepare_exit());
            assert!(state
                .begin_request(r#"{"method":"snapshot.read"}"#)
                .is_err());
        }
    }

    #[test]
    fn dropped_caller_cannot_release_a_queued_or_running_worker() {
        let state = ContentOperations::default();
        let queued = state.begin().unwrap();
        assert!(!state.prepare_exit());
        let (release, wait) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _operation = queued;
            wait.recv().unwrap();
        });
        drop(worker);
        assert!(!state.prepare_exit());
        let another = state.begin().unwrap();
        release.send(()).unwrap();
        drop(another);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !state.prepare_exit() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(state.begin().is_err());
    }

    #[test]
    fn pdf_write_guard_survives_commit_until_worker_finishes_but_read_does_not_block_quit() {
        use serde_json::json;
        let root = tempfile::tempdir().unwrap();
        let core = Arc::new(uterm_core::Core::open(root.path().join("shared-state-v1")).unwrap());
        let execute = |method: &str, params| {
            core.execute(
                &serde_json::to_vec(
                    &json!({"version":1,"id":"pdf","method":method,"params":params}),
                )
                .unwrap(),
            )
        };
        let defaults = execute("state.defaults", serde_json::Value::Null)
            .result
            .unwrap();
        assert!(execute(
            "migration.import",
            json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}})
        )
        .error
        .is_none());
        let target = json!({"directory":"/qa","path":"fixture.pdf","version":"a".repeat(64)});
        let snapshot = execute("pdf.marks.read", target.clone()).result.unwrap();
        let state = ContentOperations::default();
        assert!(state
            .begin_request(r#"{"method":"pdf.marks.read"}"#)
            .unwrap()
            .is_none());
        let mut params = target.clone();
        params["expectedRevision"] = snapshot["revision"].clone();
        params["marks"] = json!([{"id":"qa","page":1,"x":0.1,"y":0.2,"width":0.3,"height":0.1}]);
        let request =
            json!({"version":1,"id":"pdf","method":"pdf.marks.write","params":params}).to_string();
        let operation = state.begin_request(&request).unwrap().unwrap();
        let (committed, receive) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let worker_core = core.clone();
        let worker = std::thread::spawn(move || {
            let _operation = operation;
            committed
                .send(worker_core.execute(request.as_bytes()))
                .unwrap();
            wait.recv().unwrap();
        });
        assert!(receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .error
            .is_none());
        assert!(!state.prepare_exit());
        assert_eq!(
            execute("pdf.marks.read", target).result.unwrap()["marks"][0]["id"],
            "qa"
        );
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(state.prepare_exit());
        assert!(state
            .begin_request(r#"{"method":"pdf.marks.write"}"#)
            .is_err());
    }

    #[test]
    fn worker_unwind_releases_only_its_own_operation() {
        let state = ContentOperations::default();
        let first = state.begin().unwrap();
        let second = state.begin().unwrap();
        assert!(std::panic::catch_unwind(move || {
            let _operation = first;
            panic!("worker failed");
        })
        .is_err());
        assert!(!state.prepare_exit());
        drop(second);
        assert!(state.prepare_exit());
        assert!(state.prepare_exit());
        assert!(state.begin().is_err());
    }
}
