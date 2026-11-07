use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use uterm_core::{
    database::{
        self,
        service::{Operation, Request, Service},
        Host,
    },
    Core, Response,
};

fn host(root: &std::path::Path) -> Host {
    Host {
        database: Default::default(),
        components: Default::default(),
        data: root.join("data"),
        cache: root.join("cache"),
        identifier: "sh.uterm.qa.database".into(),
        prepare_ssh: Arc::new(|_| Box::pin(async { anyhow::bail!("Unexpected SSH connection") })),
        pick_file: Arc::new(|| Box::pin(async { Ok(None) })),
        events: Arc::new(|_, _| Ok(())),
    }
}
fn wait(service: &Service, operation: &Operation, consume: bool) -> Operation {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let value = service
            .read(&operation.id, &operation.generation, consume)
            .unwrap();
        if value.state != "running" {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "database operation did not complete"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn status() -> Request {
    Request::Components {
        action: "status".into(),
        id: None,
        path: None,
    }
}

#[test]
fn database_value_contract_preserves_exact_text_and_binary_values() {
    let fixture = include_bytes!("../../../shared/contracts/database-values-v1.json");
    let operation: Operation = serde_json::from_slice(fixture).unwrap();
    assert_eq!(
        operation.result.as_ref().unwrap()["rows"][0][0],
        "9223372036854775807"
    );
    assert_eq!(
        operation.result.as_ref().unwrap()["rows"][0][1],
        "12345678901234567890.1234567890"
    );
    assert_eq!(
        serde_json::to_value(operation).unwrap(),
        serde_json::from_slice::<Value>(fixture).unwrap()
    );
}

#[test]
fn unread_results_are_bounded_without_starving_disconnect_and_generations_cannot_steal_results() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    let service = Service::new(host.clone()).unwrap();
    let mut jobs = Vec::new();
    for _ in 0..8 {
        let job = service.start(status()).unwrap();
        assert_eq!(wait(&service, &job, false).state, "completed");
        jobs.push(job);
    }
    assert_eq!(
        service.start(status()).err().unwrap().to_string(),
        "DB_RESULT_LIMIT"
    );
    let control = service
        .start(Request::Disconnect {
            handle: "already-disconnected".into(),
            discard: false,
        })
        .unwrap();
    assert_eq!(wait(&service, &control, true).state, "completed");
    assert!(service
        .operations()
        .unwrap()
        .iter()
        .all(|value| value.result.is_none()));
    assert_eq!(
        service
            .read(&jobs[0].id, "stale", true)
            .err()
            .unwrap()
            .to_string(),
        "DB_OPERATION_CHANGED"
    );
    assert!(wait(&service, &jobs[0], true).result.unwrap()["items"].is_array());
    assert_eq!(
        service
            .read(&jobs[0].id, &jobs[0].generation, true)
            .err()
            .unwrap()
            .to_string(),
        "DB_RESULT_CONSUMED"
    );
    let retry = service.start(status()).unwrap();
    assert_eq!(wait(&service, &retry, true).state, "completed");
    service.close();
    service.close();
    assert_eq!(
        service.start(status()).err().unwrap().to_string(),
        "DB_CLOSED"
    );
    assert!(!host.data.exists());
}

#[test]
fn guards_errors_and_progress_do_not_expose_sql_or_secret_parameters() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    let service = Service::new(host.clone()).unwrap();
    let guard = service
        .start(Request::Guard {
            id: "database-draft".into(),
            dirty: true,
        })
        .unwrap();
    assert_eq!(wait(&service, &guard, true).state, "completed");
    assert_eq!(service.status().unwrap()["dirty"], true);
    let query = service
        .start(Request::Query {
            handle: "missing".into(),
            request: json!({"op":"query","sql":"PRIVATE_SQL_MARKER"}),
        })
        .unwrap();
    let failed = wait(&service, &query, true);
    assert_eq!(failed.error.as_deref(), Some("DB_DISCONNECTED"));
    assert!(!serde_json::to_string(&service.operations().unwrap())
        .unwrap()
        .contains("PRIVATE_SQL_MARKER"));
    let picker = service
        .start(Request::Components {
            action: "java".into(),
            id: Some("runtime".into()),
            path: None,
        })
        .unwrap();
    assert_eq!(wait(&service, &picker, true).state, "completed");
    assert!(!host.components.0.load(std::sync::atomic::Ordering::Acquire));
    assert_eq!(service.events().unwrap().len(), 1);
    assert!(service.events().unwrap().is_empty());
    host.components
        .0
        .store(true, std::sync::atomic::Ordering::Release);
    let refused = service.start(Request::Quit).unwrap();
    assert_eq!(
        wait(&service, &refused, true).error.as_deref(),
        Some("DB_BUSY")
    );
    assert_eq!(service.status().unwrap()["quitting"], false);
    assert_eq!(service.status().unwrap()["dirty"], true);
    host.components
        .0
        .store(false, std::sync::atomic::Ordering::Release);
    let quit = service.start(Request::Quit).unwrap();
    assert_eq!(wait(&service, &quit, true).state, "completed");
    assert_eq!(service.status().unwrap()["dirty"], true);
    assert_eq!(
        service.start(status()).err().unwrap().to_string(),
        "DB_QUITTING"
    );
    service.resume().unwrap();
    let resumed = service
        .start(Request::Guard {
            id: "retained-draft".into(),
            dirty: true,
        })
        .unwrap();
    assert_eq!(wait(&service, &resumed, true).state, "completed");
    assert_eq!(service.status().unwrap()["dirty"], true);
    assert!(!host.data.exists());
}

fn execute(core: &Core, method: &str, params: Value) -> Response {
    core.execute(
        &serde_json::to_vec(
            &json!({"version":1,"id":"database-client-qa","method":method,"params":params}),
        )
        .unwrap(),
    )
}

#[test]
fn core_database_configuration_is_client_scoped_and_uses_existing_ssh_authentication() {
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().join("shared-state-v1")).unwrap();
    let configured = execute(
        &core,
        "database.configure",
        json!({"identifier":"sh.uterm.qa.database-client"}),
    );
    assert!(configured.error.is_none(), "{:?}", configured.error);
    assert!(execute(
        &core,
        "ssh.configure",
        json!({"credentialService":"sh.uterm.qa.database-client.ssh"})
    )
    .error
    .is_none());
    let changed = execute(
        &core,
        "database.configure",
        json!({"identifier":"sh.uterm.qa.other"}),
    );
    assert_eq!(changed.error.unwrap().code, "DB_ALREADY_CONFIGURED");
    let invalid = execute(
        &core,
        "database.operation.start",
        json!({"kind":"guard","id":"draft","dirty":true,"password":"PRIVATE_PASSWORD_MARKER"}),
    );
    assert_eq!(invalid.error.unwrap().code, "DB_INVALID_REQUEST");
    assert!(
        !serde_json::to_string(&execute(&core, "database.operations", Value::Null))
            .unwrap()
            .contains("PRIVATE_PASSWORD_MARKER")
    );
    core.close();
}

#[test]
fn database_profiles_use_cas_preserve_other_data_and_refuse_dirty_or_secret_writes() {
    let root = tempfile::tempdir().unwrap();
    let core = Core::open(root.path().join("shared-state-v1")).unwrap();
    let defaults = execute(&core, "state.defaults", Value::Null)
        .result
        .unwrap();
    let initial = execute(
        &core,
        "migration.import",
        json!({"workspace":defaults["workspace"],"settings":defaults["settings"],"legacy":{}}),
    )
    .result
    .unwrap();
    let workspace = initial["document"]["workspace"]["selectedWorkspace"].clone();
    let id = uuid::Uuid::new_v4().to_string();
    let config = json!({"id":id,"name":"数据库 中文","kind":"postgresql","host":"127.0.0.1","port":5432,"database":"qa","username":"qa","tls":true,"ca_file":"","credential_id":null});
    let saved = execute(
        &core,
        "database.profile.save",
        json!({"expectedRevision":initial["revision"],"workspaceId":workspace,"config":config}),
    );
    assert!(saved.error.is_none(), "{:?}", saved.error);
    let saved = saved.result.unwrap();
    assert_eq!(
        saved["document"]["settings"],
        initial["document"]["settings"]
    );
    let group = saved["document"]["workspace"]["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["id"] == workspace)
        .unwrap();
    assert_eq!(group["databaseConnections"], json!([config]));
    let stale = execute(
        &core,
        "database.profile.remove",
        json!({"expectedRevision":initial["revision"],"workspaceId":workspace,"id":id}),
    );
    assert_eq!(stale.error.unwrap().code, "CONFLICT");
    let mut private = config.clone();
    private["password"] = "PRIVATE_PASSWORD_MARKER".into();
    let rejected = execute(
        &core,
        "database.profile.save",
        json!({"expectedRevision":saved["revision"],"workspaceId":workspace,"config":private}),
    );
    assert_eq!(rejected.error.unwrap().code, "DB_INVALID_REQUEST");
    let guard = execute(
        &core,
        "database.operation.start",
        json!({"kind":"guard","id":id,"dirty":true}),
    )
    .result
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let value = execute(
            &core,
            "database.operation.read",
            json!({"id":guard["id"],"generation":guard["generation"],"consume":true}),
        )
        .result
        .unwrap();
        if value["state"] == "completed" {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let dirty = execute(
        &core,
        "database.profile.remove",
        json!({"expectedRevision":saved["revision"],"workspaceId":workspace,"id":id}),
    );
    assert_eq!(dirty.error.unwrap().code, "DB_BUSY");
    let unchanged = execute(&core, "snapshot.read", Value::Null).result.unwrap();
    assert_eq!(unchanged, saved);
    assert!(!serde_json::to_string(&unchanged)
        .unwrap()
        .contains("PRIVATE_PASSWORD_MARKER"));
    core.close();
    let reopened = Core::open(root.path().join("shared-state-v1")).unwrap();
    let removed = execute(
        &reopened,
        "database.profile.remove",
        json!({"expectedRevision":saved["revision"],"workspaceId":workspace,"id":id}),
    );
    assert!(removed.error.is_none(), "{:?}", removed.error);
    let removed = removed.result.unwrap();
    assert_eq!(
        removed["document"]["workspace"],
        initial["document"]["workspace"]
    );
    assert_eq!(
        removed["document"]["settings"],
        initial["document"]["settings"]
    );
    reopened.close();
}

#[tokio::test]
async fn a_connection_finishing_after_close_cannot_register_a_new_handle() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
    };
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (started, received) = oneshot::channel();
    let (release, proceed) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        started.send(()).unwrap();
        proceed.await.unwrap();
        let body = br#"{"version":{"number":"8.0"}}"#;
        stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        stream.write_all(body).await.unwrap();
    });
    let config = serde_json::from_value(json!({"id":uuid::Uuid::new_v4().to_string(),"name":"Protocol fixture", "kind":"elasticsearch","host":"127.0.0.1","port":port,"database":"qa","username":"","tls":false,"ca_file":"","credential_id":null})).unwrap();
    let connecting = tokio::spawn(database::database_connect(
        host.clone(),
        config,
        Some(String::new()),
    ));
    tokio::time::timeout(Duration::from_secs(3), received)
        .await
        .unwrap()
        .unwrap();
    host.database.stop();
    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), connecting)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err(),
        "DB_DISCONNECTED"
    );
    assert!(!host.database.in_use());
    server.await.unwrap();
}

#[test]
#[ignore = "Requires the isolated PostgreSQL service and catalog-verified JDBC artifact"]
fn real_postgresql_exact_values_conflicts_transactions_and_cancel() {
    let root = tempfile::tempdir().unwrap();
    let driver = std::path::PathBuf::from(
        std::env::var_os("UTERM_DATABASE_TEST_DRIVER").expect("catalog driver path"),
    );
    let port: u16 = std::env::var("UTERM_DATABASE_TEST_PORT")
        .expect("isolated service port")
        .parse()
        .unwrap();
    let password = std::env::var("UTERM_DATABASE_TEST_PASSWORD").expect("ephemeral test password");
    let mut host = host(root.path());
    host.pick_file = Arc::new(move || {
        let driver = driver.clone();
        Box::pin(async move { Ok(Some(driver)) })
    });
    let service = Service::new(host.clone()).unwrap();
    let run = |request: Value| -> Operation {
        let operation = service
            .start(serde_json::from_value(request).unwrap())
            .unwrap();
        wait(&service, &operation, true)
    };
    let success = |request: Value| -> Value {
        let completed = run(request);
        assert_eq!(completed.state, "completed", "{:?}", completed.error);
        completed.result.unwrap()
    };
    let components = success(json!({"kind":"components","action":"import","id":"postgresql"}));
    assert!(components["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["id"] == "postgresql" && v["installed"] == true));
    let config = json!({"id":uuid::Uuid::new_v4().to_string(),"name":"Isolated PostgreSQL QA","kind":"postgresql","host":"127.0.0.1","port":port,"database":"uterm_qa","username":"uterm_qa","tls":false,"ca_file":"","credential_id":null});
    let main =
        success(json!({"kind":"connect","config":config,"password":password}))["handle"].clone();
    let other =
        success(json!({"kind":"connect","config":config,"password":password}))["handle"].clone();
    let query = |handle: &Value, request: Value| -> Value {
        success(json!({"kind":"request","handle":handle,"request":request}))
    };
    let exact = query(
        &main,
        json!({"op":"query","sql":"SELECT 9223372036854775807::bigint, 12345678901234567890.1234567890::numeric(30,10), decode('00ff7f','hex'), NULL::text, '中文🚀'::text"}),
    );
    assert_eq!(
        exact["rows"][0],
        json!(["9223372036854775807","12345678901234567890.1234567890",{"binary":"AP9/","truncated":false},null,"中文🚀"])
    );
    let syntax = run(
        json!({"kind":"request","handle":main,"request":{"op":"query","sql":"SELECT PRIVATE_SQL_MARKER FROM"}}),
    );
    let diagnostic = syntax.error.unwrap();
    assert!(
        diagnostic.starts_with("DB_SQL:0:42601:POSITION:"),
        "Unexpected SQL diagnostic code"
    );
    assert!(!diagnostic.contains("PRIVATE_SQL_MARKER"));
    let table = format!("uterm_qa_{}", uuid::Uuid::new_v4().simple());
    let create = format!("CREATE TABLE {table} (id integer PRIMARY KEY, value text NOT NULL)");
    assert_eq!(
        run(json!({"kind":"request","handle":main,"request":{"op":"query","sql":create}}))
            .error
            .as_deref(),
        Some("DB_READ_ONLY")
    );
    query(&main, json!({"op":"writable","enabled":true}));
    query(&main, json!({"op":"query","sql":create}));
    assert_eq!(
        run(json!({"kind":"disconnect","handle":main,"discard":false}))
            .error
            .as_deref(),
        Some("DB_PENDING")
    );
    assert_eq!(
        run(json!({"kind":"prepareQuit"})).error.as_deref(),
        Some("DB_BUSY")
    );
    query(&main, json!({"op":"rollback"}));
    assert_eq!(
        query(
            &main,
            json!({"op":"query","sql":format!("SELECT to_regclass('public.{table}')")})
        )["rows"][0][0],
        Value::Null
    );
    query(&main, json!({"op":"rollback"}));
    query(&main, json!({"op":"query","sql":create}));
    query(
        &main,
        json!({"op":"query","sql":format!("INSERT INTO {table} VALUES (1, 'original')")}),
    );
    query(&main, json!({"op":"commit"}));
    let original = query(
        &main,
        json!({"op":"table","catalog":"","schema":"public","table":table,"offset":0,"filters":[]}),
    );
    query(&other, json!({"op":"writable","enabled":true}));
    query(
        &other,
        json!({"op":"query","sql":format!("UPDATE {table} SET value='concurrent' WHERE id=1")}),
    );
    query(&other, json!({"op":"commit"}));
    let stale = run(
        json!({"kind":"request","handle":main,"request":{"op":"apply","catalog":"","schema":"public","table":table,"signature":original["table"]["signature"],"changes":[{"kind":"update","original":original["rows"][0],"values":{"value":"overwrite"}}]}}),
    );
    assert_eq!(stale.error.as_deref(), Some("DB_CONFLICT"));
    query(&main, json!({"op":"rollback"}));
    assert_eq!(
        query(
            &other,
            json!({"op":"query","sql":format!("SELECT value FROM {table} WHERE id=1")})
        )["rows"][0][0],
        "concurrent"
    );
    query(&other, json!({"op":"rollback"}));
    let sleep_sql = format!("SELECT pg_sleep(20) /* {table} */");
    let slow = service
        .start(
            serde_json::from_value(
                json!({"kind":"request","handle":main,"request":{"op":"query","sql":sleep_sql}}),
            )
            .unwrap(),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let active = query(
            &other,
            json!({"op":"query","sql":format!("SELECT count(*) FROM pg_stat_activity WHERE query = '{sleep_sql}' AND state='active'")}),
        );
        query(&other, json!({"op":"rollback"}));
        if active["rows"][0][0] == "1" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "PostgreSQL did not begin the real slow query"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let cancelled = Instant::now();
    success(json!({"kind":"disconnect","handle":main,"discard":true}));
    assert_eq!(
        wait(&service, &slow, true).error.as_deref(),
        Some("DB_DISCONNECTED")
    );
    assert!(cancelled.elapsed() < Duration::from_secs(3));
    let cancel_milliseconds = cancelled.elapsed().as_millis().to_string();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let active = query(
            &other,
            json!({"op":"query","sql":format!("SELECT count(*) FROM pg_stat_activity WHERE query = '{sleep_sql}' AND state='active'")}),
        );
        query(&other, json!({"op":"rollback"}));
        if active["rows"][0][0] == "0" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Disconnected worker retained an active database query"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    query(
        &other,
        json!({"op":"query","sql":format!("DROP TABLE {table}")}),
    );
    query(&other, json!({"op":"commit"}));
    success(json!({"kind":"disconnect","handle":other,"discard":false}));
    assert_eq!(service.status().unwrap()["connected"], false);
    assert_eq!(service.status().unwrap()["busy"], false);
    let observer = Service::new(Host {
        database: Default::default(),
        components: Default::default(),
        ..host.clone()
    })
    .unwrap();
    let opened = observer
        .start(
            serde_json::from_value(json!({"kind":"connect","config":config,"password":password}))
                .unwrap(),
        )
        .unwrap();
    let observer_handle = wait(&observer, &opened, true).result.unwrap()["handle"].clone();
    let observe = |sql: String| -> Value {
        let job = observer.start(serde_json::from_value(json!({"kind":"request","handle":observer_handle,"request":{"op":"query","sql":sql}})).unwrap()).unwrap();
        let completed = wait(&observer, &job, true);
        assert_eq!(completed.state, "completed", "{:?}", completed.error);
        completed.result.unwrap()
    };
    let closing_handle =
        success(json!({"kind":"connect","config":config,"password":password}))["handle"].clone();
    let closing_sql = format!("SELECT pg_sleep(20) /* {table}_client_close */");
    let closing_job = service.start(serde_json::from_value(json!({"kind":"request","handle":closing_handle,"request":{"op":"query","sql":closing_sql}})).unwrap()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if observe(format!("SELECT count(*) FROM pg_stat_activity WHERE query = '{closing_sql}' AND state='active'"))["rows"][0][0] == "1" { break; }
        assert!(
            Instant::now() < deadline,
            "PostgreSQL did not begin the close fixture query"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    service.close();
    assert_eq!(
        service
            .read(&closing_job.id, &closing_job.generation, true)
            .unwrap()
            .error
            .as_deref(),
        Some("DB_CLOSED")
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if observe(format!("SELECT count(*) FROM pg_stat_activity WHERE query = '{closing_sql}' AND state='active'"))["rows"][0][0] == "0" { break; }
        assert!(
            Instant::now() < deadline,
            "Closed client retained an active database query"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    observer.close();
    if let Some(path) = std::env::var_os("UTERM_DATABASE_TEST_REPORT") {
        let git = |arguments: &[&str]| {
            String::from_utf8(
                std::process::Command::new("git")
                    .args(arguments)
                    .output()
                    .unwrap()
                    .stdout,
            )
            .unwrap()
            .trim()
            .to_owned()
        };
        let report = json!({"sourceHead":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_|git(&["rev-parse","HEAD"])),"testedCommit":git(&["rev-parse","HEAD"]),"dirty":!git(&["status","--porcelain"]).is_empty(),"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"service":"PostgreSQL 16.11 (isolated real server)","jdbc":"catalog postgresql","scenarios":{"catalogVerifiedImport":true,"exactBigintDecimalBinaryNullUnicode":true,"readOnlyDefault":true,"pendingDisconnectAndQuitGuard":true,"transactionRollback":true,"staleWriteConflict":true,"realSlowQueryObservedBeforeDisconnect":true,"disconnectCancelsQuery":true,"serverQueryReleased":true,"clientCloseCancelsServerQuery":true,"noOpenHandlesOrBusyWork":true},"cancelMilliseconds":cancel_milliseconds,"nativeUiAcceptance":false,"otherDatabaseEnginesAccepted":false});
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
}
