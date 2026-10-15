use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;

#[derive(Clone, Deserialize)]
pub struct Artifact {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub filename: String,
}
#[derive(Deserialize)]
struct BundledEngine {
    sha256: String,
    size: u64,
}
#[derive(Deserialize)]
struct Catalog {
    engine: BundledEngine,
    drivers: HashMap<String, Artifact>,
    runtimes: HashMap<String, Artifact>,
}
#[derive(Serialize)]
pub struct ComponentInfo {
    id: String,
    version: String,
    size: u64,
    source: String,
    installed: bool,
    external: bool,
}
#[derive(Serialize)]
pub struct ComponentStatus {
    items: Vec<ComponentInfo>,
    java: Option<String>,
    busy: bool,
}
#[derive(Default)]
pub struct Components(pub AtomicBool, pub AtomicBool);

fn catalog() -> Result<Catalog> {
    Ok(serde_json::from_str(include_str!(
        "../../components/database/catalog.json"
    ))?)
}
pub fn root(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("database-components-v1"))
}
fn artifacts() -> Result<Vec<(String, Artifact)>> {
    let catalog = catalog()?;
    let mut result: Vec<_> = catalog.drivers.into_iter().collect();
    let target = format!(
        "{}-{}",
        if cfg!(target_os = "macos") {
            "mac"
        } else {
            "windows"
        },
        if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            "x64"
        }
    );
    if let Some(runtime) = catalog.runtimes.get(&target) {
        result.push(("runtime".into(), runtime.clone()));
    }
    result.sort_by_key(|(id, _)| id.clone());
    Ok(result)
}
fn valid_file(file: &mut fs::File, artifact: &Artifact) -> Result<bool> {
    if file.metadata()?.len() != artifact.size {
        return Ok(false);
    }
    file.rewind()?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut remaining = artifact.size;
    while remaining > 0 {
        let limit = buffer.len().min(remaining as usize);
        let count = file.read(&mut buffer[..limit])?;
        if count == 0 {
            return Ok(false);
        }
        digest.update(&buffer[..count]);
        remaining -= count as u64;
    }
    let mut extra = [0];
    let matches =
        file.read(&mut extra)? == 0 && format!("{:x}", digest.finalize()) == artifact.sha256;
    file.rewind()?;
    Ok(matches)
}
fn materialize_engine(directory: &Path) -> Result<PathBuf> {
    const BYTES: &[u8] = include_bytes!("../../components/database/engine.jar");
    let engine = catalog()?.engine;
    if BYTES.len() as u64 != engine.size || format!("{:x}", Sha256::digest(BYTES)) != engine.sha256
    {
        bail!("DB_ENGINE_INVALID");
    }
    fs::create_dir_all(directory)?;
    let destination = directory.join(format!("engine-{}.jar", engine.sha256));
    let mut cached = Vec::new();
    if fs::File::open(&destination).is_ok_and(|file| {
        file.take(engine.size + 1).read_to_end(&mut cached).is_ok() && cached == BYTES
    }) {
        return Ok(destination);
    }
    // Restore the bundled engine atomically, without trusting an installed download. 从内置资源原子恢复引擎，不依赖已下载的引擎文件。
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(BYTES)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(&destination)
        .map_err(|_| anyhow::anyhow!("DB_ENGINE_INVALID"))?;
    Ok(destination)
}
pub fn bundled_engine(app: &tauri::AppHandle) -> Result<PathBuf> {
    materialize_engine(&app.path().app_cache_dir()?.join("database-engine"))
}
pub fn checked_file(app: &tauri::AppHandle, id: &str) -> Result<PathBuf> {
    let artifact = artifacts()?
        .into_iter()
        .find(|(key, _)| key == id)
        .context("DB_COMPONENT_MISSING")?
        .1;
    let file = root(app)?.join(&artifact.filename);
    if !valid_file(
        &mut fs::File::open(&file).context("DB_COMPONENT_MISSING")?,
        &artifact,
    )? {
        bail!("DB_COMPONENT_HASH");
    }
    Ok(file)
}
fn find_java(directory: &Path, depth: usize) -> Option<PathBuf> {
    if depth > 5 {
        return None;
    }
    for entry in fs::read_dir(directory).ok()?.flatten() {
        if entry.file_type().ok()?.is_symlink() {
            continue;
        }
        let path = entry.path();
        if path.is_file()
            && path.file_name()?.to_str()? == if cfg!(windows) { "java.exe" } else { "java" }
            && path.parent()?.ends_with("bin")
        {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(java) = find_java(&path, depth + 1) {
                return Some(java);
            }
        }
    }
    None
}
pub fn java(app: &tauri::AppHandle) -> Result<PathBuf> {
    let root = root(app)?;
    if let Ok(path) = fs::read_to_string(root.join("java-path.txt")) {
        let path = PathBuf::from(path);
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
    }
    find_java(&root.join("runtime"), 0).context("DB_COMPONENT_MISSING")
}
fn java_major(value: &str) -> Option<u32> {
    let version = value.split(char::from(34)).nth(1)?;
    version.split('.').next()?.parse().ok()
}
fn validate_java(path: &Path) -> Result<()> {
    if !path.is_absolute() || !path.is_file() {
        bail!("DB_JAVA");
    }
    let mut command = Command::new(path);
    command
        .args(["-version"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = utermd_local::BackgroundChild::spawn(&mut command).context("DB_JAVA")?;
    let error = child.take_stderr().context("DB_JAVA")?;
    let start = std::time::Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if start.elapsed() > Duration::from_secs(8) {
            bail!("DB_JAVA");
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let mut version = String::new();
    error.take(4096).read_to_string(&mut version)?;
    if java_major(&version).is_none_or(|major| major < 17) {
        bail!("DB_JAVA");
    }
    Ok(())
}
pub fn status(app: &tauri::AppHandle) -> Result<ComponentStatus> {
    let root = root(app)?;
    let java = java(app).ok();
    let items = artifacts()?
        .into_iter()
        .map(|(id, artifact)| {
            let installed = if id == "runtime" {
                java.is_some()
            } else {
                fs::File::open(root.join(&artifact.filename))
                    .ok()
                    .is_some_and(|mut file| valid_file(&mut file, &artifact).unwrap_or(false))
            };
            ComponentInfo {
                id: id.clone(),
                version: artifact.version,
                size: artifact.size,
                source: artifact.url,
                external: id == "runtime" && root.join("java-path.txt").is_file() && java.is_some(),
                installed,
            }
        })
        .collect();
    Ok(ComponentStatus {
        items,
        java: java.map(|path| path.to_string_lossy().into()),
        busy: app.state::<Components>().0.load(Ordering::SeqCst),
    })
}
fn safe_entry(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
        && !path.to_string_lossy().contains(['\\', ':'])
}
fn extract(source: impl Read + Seek, name: &str, destination: &Path) -> Result<()> {
    let mut total = 0u64;
    if name.ends_with(".zip") {
        let mut archive = zip::ZipArchive::new(source)?;
        if archive.len() > 20000 {
            bail!("DB_COMPONENT_HASH");
        }
        for index in 0..archive.len() {
            let mut file = archive.by_index(index)?;
            let path = file.enclosed_name().context("DB_COMPONENT_HASH")?;
            if !safe_entry(&path) || file.is_symlink() {
                bail!("DB_COMPONENT_HASH");
            }
            total = total
                .checked_add(file.size())
                .context("DB_COMPONENT_HASH")?;
            if total > 400 * 1024 * 1024 {
                bail!("DB_COMPONENT_HASH");
            }
            let path = destination.join(path);
            if file.is_dir() {
                fs::create_dir_all(path)?;
            } else {
                fs::create_dir_all(path.parent().context("DB_COMPONENT_HASH")?)?;
                std::io::copy(&mut file, &mut fs::File::create(path)?)?;
            }
        }
    } else {
        let decoder = flate2::read::GzDecoder::new(source);
        let mut archive = tar::Archive::new(decoder);
        for (index, entry) in archive.entries()?.enumerate() {
            if index >= 20000 {
                bail!("DB_COMPONENT_HASH");
            }
            let mut entry = entry?;
            if !safe_entry(&entry.path()?) {
                bail!("DB_COMPONENT_HASH");
            }
            let kind = entry.header().entry_type();
            // Runtime links are unnecessary; refusing them prevents extraction escapes. 运行时无需归档链接，拒绝链接可避免解压越界。
            if kind.is_symlink() || kind.is_hard_link() {
                continue;
            }
            if !kind.is_file() && !kind.is_dir() {
                bail!("DB_COMPONENT_HASH");
            }
            total = total
                .checked_add(entry.size())
                .context("DB_COMPONENT_HASH")?;
            if total > 400 * 1024 * 1024 || !entry.unpack_in(destination)? {
                bail!("DB_COMPONENT_HASH");
            }
        }
    }
    Ok(())
}
async fn cancelled(app: &tauri::AppHandle) {
    loop {
        if app.state::<Components>().1.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
async fn download(
    app: &tauri::AppHandle,
    id: &str,
    artifact: &Artifact,
) -> Result<tempfile::NamedTempFile> {
    let directory = root(app)?;
    tokio::fs::create_dir_all(&directory).await?;
    let temporary = tempfile::NamedTempFile::new_in(directory)?;
    let mut output = tokio::fs::File::from_std(temporary.reopen()?);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()?;
    let mut response = tokio::select! {
        response = client.get(&artifact.url).send() => response.context("DB_COMPONENT_DOWNLOAD")?.error_for_status().context("DB_COMPONENT_DOWNLOAD")?,
        _ = cancelled(app) => bail!("DB_COMPONENT_CANCELLED"),
    };
    let mut received = 0u64;
    let mut reported = std::time::Instant::now();
    loop {
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk.context("DB_COMPONENT_DOWNLOAD")?,
            _ = cancelled(app) => bail!("DB_COMPONENT_CANCELLED"),
        };
        let Some(chunk) = chunk else {
            break;
        };
        received += chunk.len() as u64;
        if received > artifact.size {
            bail!("DB_COMPONENT_HASH");
        }
        output.write_all(&chunk).await?;
        if reported.elapsed() >= Duration::from_millis(100) || received == artifact.size {
            app.emit(
                "database-component-progress",
                serde_json::json!({"id":id,"received":received,"total":artifact.size}),
            )?;
            reported = std::time::Instant::now();
        }
    }
    output.flush().await?;
    drop(output);
    Ok(temporary)
}
fn install(
    app: &tauri::AppHandle,
    id: &str,
    source: Option<PathBuf>,
    downloaded: Option<tempfile::NamedTempFile>,
) -> Result<()> {
    let artifact = artifacts()?
        .into_iter()
        .find(|(key, _)| key == id)
        .context("DB_COMPONENT_MISSING")?
        .1;
    let root = root(app)?;
    fs::create_dir_all(&root)?;
    // Stage and verify files with bounded buffers, including offline imports. 使用有界缓冲暂存并校验文件，离线导入也采用相同限制。
    let mut staged = if let Some(path) = source {
        let mut temporary = tempfile::NamedTempFile::new_in(&root)?;
        std::io::copy(
            &mut fs::File::open(path)?.take(artifact.size + 1),
            &mut temporary,
        )?;
        temporary
    } else {
        downloaded.context("DB_COMPONENT_DOWNLOAD")?
    };
    if app.state::<Components>().1.load(Ordering::SeqCst) {
        bail!("DB_COMPONENT_CANCELLED");
    }
    staged.flush()?;
    if !valid_file(staged.as_file_mut(), &artifact)? {
        bail!("DB_COMPONENT_HASH");
    }
    if id == "runtime" {
        let temporary = tempfile::Builder::new()
            .prefix("runtime-")
            .tempdir_in(&root)?;
        extract(staged.as_file_mut(), &artifact.filename, temporary.path())?;
        let executable = find_java(temporary.path(), 0).context("DB_JAVA")?;
        validate_java(&executable)?;
        if app.state::<Components>().1.load(Ordering::SeqCst) {
            bail!("DB_COMPONENT_CANCELLED");
        }
        let destination = root.join("runtime");
        if destination.exists() {
            fs::remove_dir_all(&destination)?;
        }
        fs::rename(temporary.path(), destination)?;
        if root.join("java-path.txt").exists() {
            fs::remove_file(root.join("java-path.txt"))?;
        }
    } else {
        staged.as_file().sync_all()?;
        staged
            .persist(root.join(&artifact.filename))
            .map_err(|_| anyhow::anyhow!("DB_COMPONENT_INSTALL"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn database_components(
    app: tauri::AppHandle,
    action: String,
    id: Option<String>,
) -> Result<ComponentStatus, String> {
    if action == "status" {
        return tauri::async_runtime::spawn_blocking(move || status(&app))
            .await
            .map_err(|_| "DB_OPERATION_FAILED")?
            .map_err(|error| error.to_string());
    }
    let state = app.state::<Components>();
    if action == "cancel" {
        state.1.store(true, Ordering::SeqCst);
        return tauri::async_runtime::spawn_blocking(move || status(&app))
            .await
            .map_err(|_| "DB_OPERATION_FAILED")?
            .map_err(|error| error.to_string());
    }
    if state.0.swap(true, Ordering::SeqCst) {
        return Err("DB_BUSY".into());
    }
    state.1.store(false, Ordering::SeqCst);
    let result = async {
        if app.state::<crate::database::DatabaseState>().in_use() {
            bail!("DB_BUSY");
        }
        let id = id.context("DB_INVALID_REQUEST")?;
        if !artifacts()?.iter().any(|(key, _)| key == &id) {
            bail!("DB_INVALID_REQUEST");
        }
        let path = if action == "import" || action == "java" {
            let window = app
                .get_webview_window("main")
                .context("DB_OPERATION_FAILED")?;
            let file = tauri::async_runtime::spawn_blocking(move || {
                window
                    .dialog()
                    .file()
                    .set_parent(&window)
                    .blocking_pick_file()
            })
            .await?;
            match file {
                Some(path) => Some(
                    path.into_path()
                        .map_err(|_| anyhow::anyhow!("DB_INVALID_REQUEST"))?,
                ),
                None => return Ok(()),
            }
        } else {
            None
        };
        let downloaded = if action == "install" {
            let artifact = artifacts()?
                .into_iter()
                .find(|(key, _)| key == &id)
                .context("DB_COMPONENT_MISSING")?
                .1;
            Some(download(&app, &id, &artifact).await?)
        } else {
            None
        };
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<()> {
            if action == "java" {
                let path = path.context("DB_JAVA")?;
                validate_java(&path)?;
                fs::create_dir_all(root(&handle)?)?;
                fs::write(
                    root(&handle)?.join("java-path.txt"),
                    path.to_string_lossy().as_bytes(),
                )?;
            } else if action == "install" || action == "import" {
                install(&handle, &id, path, downloaded)?;
            } else if action == "remove" {
                let artifact = artifacts()?
                    .into_iter()
                    .find(|(key, _)| key == &id)
                    .context("DB_INVALID_REQUEST")?
                    .1;
                if id == "runtime" {
                    let root = root(&handle)?;
                    if root.join("runtime").exists() {
                        fs::remove_dir_all(root.join("runtime"))?;
                    }
                    if root.join("java-path.txt").exists() {
                        fs::remove_file(root.join("java-path.txt"))?;
                    }
                } else {
                    let file = root(&handle)?.join(artifact.filename);
                    if file.exists() {
                        fs::remove_file(file)?;
                    }
                }
            } else {
                bail!("DB_INVALID_REQUEST");
            }
            Ok(())
        })
        .await??;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    state.0.store(false, Ordering::SeqCst);
    let _ = app.emit("database-components-changed", ());
    result.map_err(|error| error.to_string())?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || status(&handle))
        .await
        .map_err(|_| "DB_OPERATION_FAILED")?
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_and_extraction_are_bounded() {
        let catalog = catalog().unwrap();
        assert_eq!(catalog.drivers.len(), 3);
        assert!(artifacts().unwrap().iter().all(|(id, _)| id != "engine"));
        for (_, artifact) in artifacts().unwrap() {
            assert!(artifact.url.starts_with("https://"));
            assert_eq!(artifact.sha256.len(), 64);
            assert!(artifact.size > 0 && artifact.size < 100 * 1024 * 1024);
            let mut file = tempfile::tempfile().unwrap();
            file.write_all(b"tampered").unwrap();
            assert!(!valid_file(&mut file, &artifact).unwrap());
        }
        assert!(!safe_entry(Path::new("../escape")));
        assert!(!safe_entry(Path::new("/escape")));
        assert!(!safe_entry(Path::new("C:\\escape")));
        assert_eq!(java_major("openjdk version \"21.0.12\""), Some(21));
        assert_eq!(java_major("java version \"1.8.0\""), Some(1));
    }

    #[test]
    fn component_verification_streams_and_rejects_wrong_sizes_or_modified_bytes() {
        let bytes = vec![42u8; 200_000];
        let artifact = Artifact {
            version: "qa".into(),
            url: String::new(),
            filename: "qa.jar".into(),
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        };
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&bytes).unwrap();
        assert!(valid_file(&mut file, &artifact).unwrap());
        assert_eq!(file.stream_position().unwrap(), 0);
        file.write_all(b"tampered").unwrap();
        assert!(!valid_file(&mut file, &artifact).unwrap());
        file.set_len(64 * 1024 * 1024).unwrap();
        file.rewind().unwrap();
        assert!(!valid_file(&mut file, &artifact).unwrap());
        assert_eq!(file.stream_position().unwrap(), 0);
    }

    #[test]
    fn bundled_engine_is_available_offline_and_repairs_a_modified_cache() {
        let directory = tempfile::tempdir().unwrap();
        let file = materialize_engine(directory.path()).unwrap();
        let original = fs::read(&file).unwrap();
        assert_eq!(
            original.as_slice(),
            include_bytes!("../../components/database/engine.jar")
        );
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&original)).unwrap();
        let mut header = [0u8; 8];
        archive
            .by_name("DatabaseBridge.class")
            .unwrap()
            .read_exact(&mut header)
            .unwrap();
        assert_eq!(&header[0..4], &[0xca, 0xfe, 0xba, 0xbe]);
        assert_eq!(u16::from_be_bytes([header[6], header[7]]), 61);
        assert_eq!(materialize_engine(directory.path()).unwrap(), file);
        fs::write(&file, b"invalid download").unwrap();
        assert_eq!(materialize_engine(directory.path()).unwrap(), file);
        assert_eq!(fs::read(&file).unwrap(), original);
        fs::remove_file(&file).unwrap();
        assert_eq!(materialize_engine(directory.path()).unwrap(), file);
        assert_eq!(fs::read(&file).unwrap(), original);
    }

    #[test]
    fn runtime_archives_extract_regular_files_and_reject_zip_traversal() {
        use std::io::Cursor;
        let destination = tempfile::tempdir().unwrap();
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o755);
        header.set_size(4);
        header.set_cksum();
        archive
            .append_data(&mut header, "jre/bin/java", Cursor::new(b"test"))
            .unwrap();
        let bytes = archive.into_inner().unwrap().finish().unwrap();
        extract(Cursor::new(&bytes), "runtime.tar.gz", destination.path()).unwrap();
        assert_eq!(
            fs::read(destination.path().join("jre/bin/java")).unwrap(),
            b"test"
        );

        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(
            "../outside",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        zip.write_all(b"escape").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert!(extract(Cursor::new(&bytes), "runtime.zip", destination.path()).is_err());
        assert!(!destination.path().join("outside").exists());
    }
}
