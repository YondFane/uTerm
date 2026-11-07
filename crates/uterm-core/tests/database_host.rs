use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use uterm_core::{
    database::{self, DatabaseState, Host},
    database_components::{self, Components},
};

fn host(root: &std::path::Path, picks: Arc<AtomicUsize>, events: Arc<AtomicUsize>) -> Host {
    Host {
        database: DatabaseState::default(),
        components: Components::default(),
        data: root.join("data"),
        cache: root.join("cache"),
        identifier: "sh.uterm.desktop.qa.database-core".into(),
        prepare_ssh: Arc::new(|_| Box::pin(async { anyhow::bail!("Unexpected SSH connection") })),
        pick_file: Arc::new(move || {
            picks.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(None) })
        }),
        events: Arc::new(move |kind, _| {
            assert_eq!(kind, "database-components-changed");
            events.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }),
    }
}

#[test]
fn separate_command_contexts_share_drafts_and_component_exit_protection() {
    let root = tempfile::tempdir().unwrap();
    let original = host(root.path(), Arc::default(), Arc::default());
    database::database_guard(original.clone(), "draft".into(), true).unwrap();
    assert!(original.database.dirty());
    let another = original.clone();
    another.components.0.store(true, Ordering::SeqCst);
    assert_eq!(
        database::database_prepare_exit(original.clone()).unwrap_err(),
        "DB_BUSY"
    );
    assert!(original.database.dirty());
    another.components.0.store(false, Ordering::SeqCst);
    database::database_prepare_exit(another).unwrap();
    assert!(!original.database.dirty());
    assert!(!original.data.exists());
}

#[tokio::test]
async fn cancelled_native_picker_releases_install_guard_without_creating_configuration() {
    let root = tempfile::tempdir().unwrap();
    let picks = Arc::new(AtomicUsize::new(0));
    let events = Arc::new(AtomicUsize::new(0));
    let host = host(root.path(), picks.clone(), events.clone());
    database_components::database_components(host.clone(), "java".into(), Some("runtime".into()))
        .await
        .unwrap();
    assert_eq!(picks.load(Ordering::SeqCst), 1);
    assert_eq!(events.load(Ordering::SeqCst), 1);
    assert!(!host.components.0.load(Ordering::SeqCst));
    assert!(!host.data.exists());
    let bundle = root.path().join("application.bin");
    std::fs::write(&bundle, b"RETAIN_BUNDLE").unwrap();
    let engine = database_components::bundled_engine(&host).unwrap();
    assert!(engine.starts_with(&host.cache));
    std::fs::write(&engine, b"damaged").unwrap();
    assert_eq!(database_components::bundled_engine(&host).unwrap(), engine);
    assert_eq!(std::fs::read(&bundle).unwrap(), b"RETAIN_BUNDLE");
    assert_eq!(std::fs::metadata(engine).unwrap().len(), 35462);
}
