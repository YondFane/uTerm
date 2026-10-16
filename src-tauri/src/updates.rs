use anyhow::{Context, Result};
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{ipc::Channel, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates(tauri::async_runtime::Mutex<Pending>);
#[derive(Default)]
struct Pending {
    update: Option<Update>,
    downloaded: Option<PathBuf>,
}

fn signature_parts(
    signature: &str,
    config: &tauri_plugin_updater::Config,
) -> Result<(minisign_verify::PublicKey, minisign_verify::Signature)> {
    let decode = |value: &str| -> Result<String> {
        Ok(String::from_utf8(
            base64::engine::general_purpose::STANDARD.decode(value)?,
        )?)
    };
    Ok((
        minisign_verify::PublicKey::decode(&decode(&config.pubkey)?)?,
        minisign_verify::Signature::decode(&decode(signature)?)?,
    ))
}

fn verify(
    bytes: &[u8],
    signature: &str,
    version: &str,
    config: &tauri_plugin_updater::Config,
) -> Result<()> {
    let (key, signature) = signature_parts(signature, config)?;
    // Match the updater's pre-install verification, including the authenticated version comment.
    // 保持更新器安装前的验证规则一致，包括经过认证的版本注释。
    key.verify(bytes, &signature, true)?;
    verify_version(&signature, version, config.require_signed_version)
}

fn verify_version(
    signature: &minisign_verify::Signature,
    version: &str,
    required: bool,
) -> Result<()> {
    if let Some(signed) = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
    {
        let matches = match (
            semver::Version::parse(signed.trim_start_matches('v')),
            semver::Version::parse(version.trim_start_matches('v')),
        ) {
            (Ok(signed), Ok(version)) => signed == version,
            _ => signed == version,
        };
        if !matches {
            anyhow::bail!("DOWNLOAD_VERIFY");
        }
    } else if required {
        anyhow::bail!("DOWNLOAD_VERIFY");
    }
    Ok(())
}

fn read_verified(
    path: &Path,
    signature: &str,
    version: &str,
    config: &tauri_plugin_updater::Config,
) -> Result<Vec<u8>> {
    let file = std::fs::File::open(path).context("DOWNLOAD_STORAGE")?;
    let length = file.metadata().context("DOWNLOAD_STORAGE")?.len();
    if length > crate::downloads::LIMIT {
        anyhow::bail!("DOWNLOAD_RESPONSE");
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(crate::downloads::LIMIT + 1)
        .read_to_end(&mut bytes)
        .context("DOWNLOAD_STORAGE")?;
    if bytes.len() as u64 > crate::downloads::LIMIT {
        anyhow::bail!("DOWNLOAD_RESPONSE");
    }
    verify(&bytes, signature, version, config).context("DOWNLOAD_VERIFY")?;
    Ok(bytes)
}

fn verify_file(
    path: &Path,
    signature: &str,
    version: &str,
    config: &tauri_plugin_updater::Config,
) -> Result<()> {
    let (key, signed) = signature_parts(signature, config)?;
    let mut verifier = match key.verify_stream(&signed) {
        Ok(verifier) => verifier,
        // Older unprehashed signatures still use the updater's compatible byte verifier.
        // 较早的非预哈希签名仍使用更新器兼容的整包字节验证。
        Err(minisign_verify::Error::UnsupportedLegacyMode) => {
            return read_verified(path, signature, version, config).map(|_| ())
        }
        Err(error) => return Err(error.into()),
    };
    let mut file = std::fs::File::open(path).context("DOWNLOAD_STORAGE")?;
    let mut buffer = [0u8; 64 * 1024];
    let mut received = 0u64;
    loop {
        let count = file.read(&mut buffer).context("DOWNLOAD_STORAGE")?;
        if count == 0 {
            break;
        }
        received += count as u64;
        if received > crate::downloads::LIMIT {
            anyhow::bail!("DOWNLOAD_RESPONSE");
        }
        verifier.update(&buffer[..count]);
    }
    verifier.finalize()?;
    verify_version(&signed, version, config.require_signed_version)
}

fn configuration(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Config, String> {
    serde_json::from_value(
        app.config()
            .plugins
            .0
            .get("updater")
            .cloned()
            .ok_or("DOWNLOAD_METADATA")?,
    )
    .map_err(|_| "DOWNLOAD_METADATA".into())
}

fn check_error(error: tauri_plugin_updater::Error) -> anyhow::Error {
    match error {
        tauri_plugin_updater::Error::Reqwest(error) => {
            crate::downloads::classify_network(&format!("{error:?}"), error.is_timeout())
        }
        tauri_plugin_updater::Error::ReleaseNotFound => anyhow::anyhow!("DOWNLOAD_METADATA"),
        _ => anyhow::anyhow!("DOWNLOAD_METADATA"),
    }
}
#[derive(Serialize)]
pub struct Availability {
    enabled: bool,
    version: String,
    notes: Option<String>,
    downloaded: bool,
}
#[derive(Clone, Serialize)]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}
fn enabled(app: &tauri::AppHandle) -> bool {
    !cfg!(debug_assertions)
        && app.config().identifier == "sh.uterm.desktop"
        && app.config().plugins.0.contains_key("updater")
}
fn require_enabled(app: &tauri::AppHandle) -> Result<(), String> {
    if !enabled(app) {
        return Err("此构建未启用在线更新。请使用正式渠道安装包。".into());
    }
    Ok(())
}
fn availability(app: &tauri::AppHandle, pending: &Pending) -> Availability {
    Availability {
        enabled: enabled(app),
        version: pending
            .update
            .as_ref()
            .map(|u| u.version.clone())
            .unwrap_or_default(),
        notes: pending.update.as_ref().and_then(|u| u.body.clone()),
        downloaded: pending.downloaded.is_some(),
    }
}
#[tauri::command]
pub async fn update_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<Availability, String> {
    let pending = state.0.try_lock().map_err(|_| "更新操作正在进行。")?;
    Ok(availability(&app, &pending))
}
#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<Availability, String> {
    require_enabled(&app)?;
    let mut pending = state.0.try_lock().map_err(|_| "更新操作正在进行。")?;
    let mut update = None;
    for attempt in 0..crate::downloads::ATTEMPTS {
        match app
            .updater_builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|_| "DOWNLOAD_METADATA")?
            .check()
            .await
        {
            Ok(found) => {
                update = found;
                break;
            }
            Err(error) => {
                let error = check_error(error);
                if !crate::downloads::retryable(&error) || attempt + 1 == crate::downloads::ATTEMPTS
                {
                    return Err(error.to_string());
                }
                crate::downloads::delay(attempt, &AtomicBool::new(false))
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    if let Some(update) = &mut update {
        update.timeout = Some(std::time::Duration::from_secs(600));
    }
    pending.update = update;
    pending.downloaded = None;
    Ok(availability(&app, &pending))
}
#[tauri::command]
pub async fn update_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
    events: Channel<Progress>,
) -> Result<(), String> {
    require_enabled(&app)?;
    let mut pending = state.0.try_lock().map_err(|_| "更新操作正在进行。")?;
    let update = pending.update.as_ref().ok_or("请先检查更新。")?;
    let config = configuration(&app)?;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| "DOWNLOAD_STORAGE")?
        .join("updates-v1");
    let key = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}\0{}\0{}\0{}\0{}",
                update.version, update.target, update.download_url, update.signature, config.pubkey
            )
            .as_bytes()
        )
    );
    let path = crate::downloads::fetch(
        &directory,
        &key,
        update.download_url.as_str(),
        &AtomicBool::new(false),
        |downloaded, total| {
            if let Err(error) = events.send(Progress { downloaded, total }) {
                eprintln!("Update progress: {error}");
            }
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    let signature = update.signature.clone();
    let version = update.version.clone();
    let cached_path = path.clone();
    let verified = tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        verify_file(&cached_path, &signature, &version, &config).map_err(|error| {
            if matches!(
                error.to_string().as_str(),
                "DOWNLOAD_STORAGE" | "DOWNLOAD_RESPONSE"
            ) {
                error
            } else {
                anyhow::anyhow!("DOWNLOAD_VERIFY")
            }
        })
    })
    .await
    .map_err(|_| "DOWNLOAD_VERIFY")?;
    if let Err(error) = verified {
        if error.to_string() == "DOWNLOAD_VERIFY" {
            crate::downloads::discard(&directory, &key).await;
        }
        return Err(error.to_string());
    }
    pending.downloaded = Some(path);
    Ok(())
}
#[tauri::command]
pub async fn update_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, Updates>,
) -> Result<(), String> {
    require_enabled(&app)?;
    let mut pending = state.0.try_lock().map_err(|_| "更新操作正在进行。")?;
    let update = pending.update.as_ref().ok_or("请先检查更新。")?;
    let path = pending.downloaded.as_ref().ok_or("请先下载更新。")?.clone();
    let config = configuration(&app)?;
    let signature = update.signature.clone();
    let version = update.version.clone();
    // Keep only the cache path while ready; load and reverify bytes before the existing guards.
    // 就绪期间只保留缓存路径；安装时先加载并重新验证，再经过现有保护检查。
    let cached_path = path.clone();
    let verified = tauri::async_runtime::spawn_blocking(move || {
        read_verified(&cached_path, &signature, &version, &config)
    })
    .await
    .map_err(|_| "DOWNLOAD_VERIFY")?;
    let bytes = match verified {
        Ok(bytes) => bytes,
        Err(error) => {
            pending.downloaded = None;
            if matches!(
                error.to_string().as_str(),
                "DOWNLOAD_VERIFY" | "DOWNLOAD_RESPONSE"
            ) {
                if let (Some(directory), Some(key)) = (
                    path.parent(),
                    path.file_stem().and_then(|value| value.to_str()),
                ) {
                    crate::downloads::discard(directory, key).await;
                }
            }
            return Err(error.to_string());
        }
    };
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("local-daemon-v1");
    tauri::async_runtime::spawn_blocking(move || {
        utermd_local::daemon::ensure_update_safe(&root).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    // Windows installers can exit the process directly, bypassing ExitRequested.
    // Windows 安装器可能直接退出进程，绕过退出事件，因此必须在安装前检查编辑器保护状态。
    if app
        .state::<crate::files::EditorGuard>()
        .0
        .load(Ordering::SeqCst)
    {
        return Err("请先保存或放弃文件修改，再安装更新。".into());
    }
    if app.state::<crate::database::DatabaseState>().busy()
        || app.state::<crate::database::DatabaseState>().dirty()
        || app
            .state::<crate::database_components::Components>()
            .0
            .load(Ordering::SeqCst)
    {
        return Err("请先完成数据库操作、提交或回滚事务并处理 SQL 草稿，再安装更新。".into());
    }
    if app.state::<crate::redis::RedisState>().dirty()
        || app.state::<crate::redis::RedisState>().busy()
    {
        return Err("请先保存或放弃 Redis 修改，再安装更新。".into());
    }
    if app.state::<crate::ssh::SshFiles>().busy() {
        return Err("文件仍在传输。请等待完成或取消传输。".into());
    }
    update.install(&bytes).map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires an explicitly generated signed resource fixture"]
    fn update_resource_profile() {
        let root = PathBuf::from(
            std::env::var_os("UTERM_RESOURCE_FIXTURE").expect("resource fixture directory"),
        );
        let public_key = std::fs::read_to_string(root.join("key.pub")).unwrap();
        let signature = std::fs::read_to_string(root.join("update-payload.bin.sig")).unwrap();
        let config = tauri_plugin_updater::Config {
            pubkey: public_key.trim().into(),
            require_signed_version: true,
            ..Default::default()
        };
        let started = std::time::Instant::now();
        if std::env::var("UTERM_RESOURCE_MODE").unwrap() == "bytes" {
            let bytes = read_verified(
                &root.join("update-payload.bin"),
                signature.trim(),
                "1.2.3",
                &config,
            )
            .unwrap();
            std::hint::black_box(&bytes);
            std::thread::sleep(std::time::Duration::from_millis(500));
        } else {
            verify_file(
                &root.join("update-payload.bin"),
                signature.trim(),
                "1.2.3",
                &config,
            )
            .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        println!("update_profile_ms={}", started.elapsed().as_millis());
    }

    #[test]
    fn cached_updates_require_valid_content_key_and_signed_version() {
        let public_key = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQzMDRCMDg1NDI5RDlENkEKUldScW5aMUNoYkFFUTB5SlFDN2s1S3ptNy9BeHo2bGVYVFJreGV1b1N1cHNHdlc3MzFaZHZPSkUK";
        let signature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVScW5aMUNoYkFFUS9qRWRuOFNicStaMGFoeTZ3NHR5enVnWjhpdWg0V1N0UHhpOXBMeVRyQ2NDWWNzeWNRVHNLVkwxa3lVUUxqWXhPVTdRTWNVVytoWEVwRFJCdlk5R3dBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyMTYzODQyCWZpbGU6cGF5bG9hZAl2ZXJzaW9uOjEuMi4zCnFrTmltSWpocFhkVnZZaE5HMXRuWjNDYTF6dHQrRG5aOE9WRW55eExYYU5EcUFTc2xYZ1c0SUVRbThyYjZ3U3VkaFg5M0xIYnhkMnJrcWh6SmJseEJBPT0K";
        let mut config = tauri_plugin_updater::Config {
            pubkey: public_key.into(),
            require_signed_version: true,
            ..Default::default()
        };
        let bytes = b"uTerm download verification fixture";
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cached-update");
        std::fs::write(&path, bytes).unwrap();
        assert!(verify_file(&path, signature, "1.2.3", &config).is_ok());
        assert_eq!(
            read_verified(&path, signature, "1.2.3", &config).unwrap(),
            bytes
        );
        assert!(verify_file(&path, signature, "1.2.4", &config).is_err());
        std::fs::write(&path, b"modified after download").unwrap();
        assert!(verify_file(&path, signature, "1.2.3", &config).is_err());
        assert!(read_verified(&path, signature, "1.2.3", &config).is_err());
        assert!(verify(bytes, signature, "1.2.3", &config).is_ok());
        assert!(verify(bytes, signature, "v1.2.3", &config).is_ok());
        assert!(verify(b"tampered cached bytes", signature, "1.2.3", &config).is_err());
        assert!(verify(bytes, signature, "1.2.4", &config).is_err());
        assert!(verify(bytes, "not a signature", "1.2.3", &config).is_err());
        config.pubkey = "invalid key".into();
        assert!(verify(bytes, signature, "1.2.3", &config).is_err());
    }
}
