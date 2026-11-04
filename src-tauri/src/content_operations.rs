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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

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
