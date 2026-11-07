use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};
use uterm_core::redis::{self, Host};

fn host() -> Host {
    Host {
        state: Default::default(),
        identifier: "sh.uterm.qa.redis-core".into(),
        prepare_ssh: Arc::new(|_| Box::pin(async { anyhow::bail!("Unexpected SSH connection") })),
    }
}

async fn handshake_fixture() -> (
    u16,
    oneshot::Receiver<()>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (started, received) = oneshot::channel();
    let (release, proceed) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut data = [0; 4096];
        assert!(socket.read(&mut data).await.unwrap() > 0);
        started.send(()).unwrap();
        if proceed.await.is_ok() {
            let _ = socket.write_all(b"+OK\r\n").await;
        }
        assert_eq!(socket.read(&mut data).await.unwrap(), 0);
    });
    (port, received, release, server)
}
fn config(port: u16) -> redis::Config {
    serde_json::from_value(json!({"id":uuid::Uuid::new_v4().to_string(),"name":"Delayed handshake", "host":"127.0.0.1","port":port,"db":0,"username":"qa","tls":false,"ca_file":"","server_name":"","ssh_host":"","credential_id":null})).unwrap()
}

#[tokio::test]
async fn a_late_authenticated_connection_cannot_register_after_shared_state_shutdown() {
    let (port, started, release, server) = handshake_fixture().await;
    let host = host();
    let cloned = host.clone();
    let connecting = tokio::spawn(redis::redis_connect(
        host.clone(),
        config(port),
        Some("private-qa".into()),
    ));
    tokio::time::timeout(Duration::from_secs(3), started)
        .await
        .unwrap()
        .unwrap();
    assert!(cloned.state.busy());
    cloned.state.shutdown().await;
    release.send(()).unwrap();
    let error = tokio::time::timeout(Duration::from_secs(3), connecting)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error, "REDIS_RECONNECT");
    assert!(!host.state.busy());
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn cancelling_an_authentication_releases_the_opening_slot_and_transport() {
    let (port, started, release, server) = handshake_fixture().await;
    let host = host();
    let connecting = tokio::spawn(redis::redis_connect(
        host.clone(),
        config(port),
        Some("private-qa".into()),
    ));
    tokio::time::timeout(Duration::from_secs(3), started)
        .await
        .unwrap()
        .unwrap();
    assert!(host.state.busy());
    connecting.abort();
    assert!(connecting.await.unwrap_err().is_cancelled());
    assert!(!host.state.busy());
    drop(release);
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    redis::redis_guard(host.clone(), id.clone(), true).unwrap();
    assert_eq!(
        host.clone().state.first_dirty().as_deref(),
        Some(id.as_str())
    );
    redis::redis_guard(host.clone(), id, false).unwrap();
    assert!(!host.state.dirty());
}
