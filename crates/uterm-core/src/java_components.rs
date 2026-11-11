use crate::database_components::{Artifact, InstallPackage};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[path = "java_components_service.rs"]
pub mod service;

#[derive(Clone)]
pub struct Host {
    pub data: PathBuf,
    pub components: Components,
    pub events: Arc<dyn Fn(&str, serde_json::Value) -> Result<()> + Send + Sync>,
    #[cfg(test)]
    catalog: Option<Arc<HashMap<String, Artifact>>>,
}
impl Host {
    pub fn new(data: PathBuf) -> Self {
        Self {
            data,
            components: Components::default(),
            events: Arc::new(|_, _| Ok(())),
            #[cfg(test)]
            catalog: None,
        }
    }
}

const MAX_TOOL_HOME_DEPTH: usize = 6;
const MAX_ENTRIES_PER_DIRECTORY: usize = 10000;
const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct Components {
    busy: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    commit_gate: Arc<std::sync::Mutex<bool>>,
}
impl Components {
    pub fn cancel(&self) {
        let _gate = self
            .commit_gate
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.cancelled.store(true, Ordering::SeqCst);
    }
    pub fn close(&self) {
        let mut closed = self
            .commit_gate
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *closed = true;
        self.cancelled.store(true, Ordering::SeqCst);
    }
}
struct Lease {
    _busy: BusyGuard,
    _writer: crate::configuration::ConfigurationWriter,
}
struct BusyGuard(Components);
impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
    }
}
#[derive(Clone, Serialize, serde::Deserialize, schemars::JsonSchema)]
#[schemars(rename = "JavaComponentItem")]
pub struct Item {
    id: String,
    version: String,
    size: u32,
    source: String,
    installed: bool,
    downloaded: u32,
}
#[derive(Clone, Serialize, serde::Deserialize, schemars::JsonSchema)]
#[schemars(rename = "JavaComponentCatalog")]
pub struct Status {
    items: Vec<Item>,
    busy: bool,
}
fn catalog(_app: &Host) -> Result<HashMap<String, Artifact>> {
    #[cfg(test)]
    if let Some(catalog) = &_app.catalog {
        return Ok(catalog.as_ref().clone());
    }
    if !cfg!(any(windows, target_os = "macos")) {
        bail!("JAVA_PLATFORM_UNSUPPORTED");
    }
    let catalog: HashMap<String, HashMap<String, Artifact>> =
        serde_json::from_str(include_str!("../../../components/java/catalog.json"))?;
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
    catalog
        .get(&target)
        .cloned()
        .context("JAVA_PLATFORM_UNSUPPORTED")
}
pub fn status(app: &Host) -> Result<Status> {
    let root = crate::java::managed_root(&app.data)?;
    let mut items: Vec<_> = catalog(app)?
        .into_iter()
        .map(|(id, artifact)| {
            let installed = tool_installed(&root, &id);
            let downloaded = fs::metadata(
                root.join("downloads")
                    .join(format!("{}.part", artifact.sha256)),
            )
            .map(|value| value.len().min(artifact.size))
            .unwrap_or_default();
            Ok(Item {
                id,
                version: artifact.version,
                size: u32::try_from(artifact.size).context("JAVA_COMPONENT_INVALID")?,
                source: artifact.url,
                installed,
                downloaded: u32::try_from(downloaded).context("JAVA_COMPONENT_INVALID")?,
            })
        })
        .collect::<Result<_>>()?;
    items.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Status {
        items,
        busy: app.components.busy.load(Ordering::SeqCst),
    })
}
fn tool_executable(id: &str) -> &'static str {
    if id == "maven" {
        if cfg!(windows) {
            "mvn.cmd"
        } else {
            "mvn"
        }
    } else if cfg!(windows) {
        "javac.exe"
    } else {
        "javac"
    }
}
fn tool_installed(root: &Path, id: &str) -> bool {
    fs::read_to_string(root.join(id).join("home.txt"))
        .ok()
        .is_some_and(|home| {
            Path::new(home.trim())
                .join("bin")
                .join(tool_executable(id))
                .is_file()
        })
}
fn find_tool_home(root: &Path, id: &str, depth: usize) -> Option<PathBuf> {
    if depth > MAX_TOOL_HOME_DEPTH {
        return None;
    }
    if root.join("bin").join(tool_executable(id)).is_file() {
        return Some(root.into());
    }
    for entry in fs::read_dir(root)
        .ok()?
        .flatten()
        .take(MAX_ENTRIES_PER_DIRECTORY)
    {
        if entry.file_type().ok()?.is_dir() {
            if let Some(path) = find_tool_home(&entry.path(), id, depth + 1) {
                return Some(path);
            }
        }
    }
    None
}
async fn install(app: &Host, id: &str, source: Option<PathBuf>, lease: Arc<Lease>) -> Result<()> {
    if app.components.cancelled.load(Ordering::SeqCst) {
        bail!("DB_COMPONENT_CANCELLED");
    }
    let artifact = catalog(app)?.remove(id).context("JAVA_COMPONENT_MISSING")?;
    let root = crate::java::managed_root(&app.data)?;
    fs::create_dir_all(&root)?;
    let downloaded = if source.is_none() {
        Some(download_archive(app, id, &artifact, &root).await?)
    } else {
        None
    };
    let app = app.clone();
    let id = id.to_owned();
    tokio::task::spawn_blocking(move || {
        let _lease = lease;
        install_archive(&root, &id, &artifact, source, downloaded, &app.components)
    })
    .await??;
    Ok(())
}
async fn download_archive(
    app: &Host,
    id: &str,
    artifact: &Artifact,
    root: &Path,
) -> Result<PathBuf> {
    let mut downloaded = None;
    for attempt in 0..crate::downloads::ATTEMPTS {
        match crate::database_components::download_file(
            root,
            artifact,
            &app.components.cancelled,
            |received| {
                (app.events)(
                    "java-component-progress",
                    serde_json::json!({"id":id,"received":received,"total":artifact.size}),
                )?;
                Ok(())
            },
        )
        .await
        {
            Ok(file) => {
                downloaded = Some(file);
                break;
            }
            Err(error)
                if crate::downloads::retryable(&error)
                    && attempt + 1 < crate::downloads::ATTEMPTS =>
            {
                crate::downloads::delay(attempt, &app.components.cancelled).await?
            }
            Err(error) => return Err(error),
        }
    }
    let mut file = downloaded.context("DOWNLOAD_NETWORK")?;
    let artifact = artifact.clone();
    let path = tokio::task::spawn_blocking(move || {
        if !crate::database_components::valid_file(file.as_file_mut(), &artifact)? {
            bail!("DB_COMPONENT_HASH");
        }
        // Release temporary ownership only after verification so installation failures keep the cache.
        // 仅在校验通过后释放临时文件所有权，使安装失败时仍保留下载缓存。
        let (_, path) = file.keep().map_err(|error| anyhow::anyhow!(error.error))?;
        Ok::<_, anyhow::Error>(path)
    })
    .await??;
    crate::downloads::prune(path.parent().context("DOWNLOAD_STORAGE")?, &path).await?;
    Ok(path)
}
fn install_archive(
    root: &Path,
    id: &str,
    artifact: &Artifact,
    source: Option<PathBuf>,
    downloaded: Option<PathBuf>,
    components: &Components,
) -> Result<()> {
    let cancelled = &components.cancelled;
    if cancelled.load(Ordering::SeqCst) {
        bail!("DB_COMPONENT_CANCELLED");
    }
    let mut package = InstallPackage::open(root, artifact, source, downloaded)?;
    if cancelled.load(Ordering::SeqCst) {
        bail!("DB_COMPONENT_CANCELLED");
    }
    if !crate::database_components::valid_file(package.file(), artifact)? {
        bail!("DB_COMPONENT_HASH");
    }
    let install_root = root.join(id);
    fs::create_dir_all(&install_root)?;
    let destination = install_root.join(&artifact.sha256);
    if !destination.exists() {
        let stage = tempfile::Builder::new()
            .prefix("install-")
            .tempdir_in(&install_root)?;
        crate::archives::extract_bounded(
            package.file(),
            &artifact.filename,
            stage.path(),
            MAX_EXTRACTED_BYTES,
            true,
        )?;
        if cancelled.load(Ordering::SeqCst) {
            bail!("DB_COMPONENT_CANCELLED");
        }
        find_tool_home(stage.path(), id, 0).context("JAVA_COMPONENT_INVALID")?;
        fs::rename(stage.path(), &destination)?;
    }
    let home = find_tool_home(&destination, id, 0).context("JAVA_COMPONENT_INVALID")?;
    if id != "maven" {
        crate::java::probe(&home)?;
    }
    let closed = components
        .commit_gate
        .lock()
        .map_err(|_| anyhow::anyhow!("JAVA_OPERATION_FAILED"))?;
    if *closed || cancelled.load(Ordering::SeqCst) {
        bail!("DB_COMPONENT_CANCELLED");
    }
    let mut pointer = tempfile::NamedTempFile::new_in(&install_root)?;
    pointer.write_all(home.to_str().context("JAVA_PROJECT_INVALID")?.as_bytes())?;
    pointer.as_file().sync_all()?;
    pointer
        .persist(install_root.join("home.txt"))
        .map_err(|_| anyhow::anyhow!("DOWNLOAD_STORAGE"))?;
    Ok::<_, anyhow::Error>(())
}
fn begin(app: &Host, action: &str, id: &str, source: Option<&Path>) -> Result<BusyGuard> {
    if !["install", "import"].contains(&action) {
        bail!("JAVA_TASK_INVALID");
    }
    if (action == "import") != source.is_some() {
        bail!("JAVA_COMPONENT_INVALID");
    }
    catalog(app)?.get(id).context("JAVA_COMPONENT_MISSING")?;
    let closed = app
        .components
        .commit_gate
        .lock()
        .map_err(|_| anyhow::anyhow!("JAVA_OPERATION_FAILED"))?;
    if *closed {
        bail!("JAVA_COMPONENT_CLOSED");
    }
    if app
        .components
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        bail!("JAVA_TASK_BUSY");
    }
    app.components.cancelled.store(false, Ordering::SeqCst);
    Ok(BusyGuard(app.components.clone()))
}
async fn execute_reserved(
    app: Host,
    id: String,
    source: Option<PathBuf>,
    guard: BusyGuard,
) -> Result<Status> {
    let root = crate::java::managed_root(&app.data)?;
    let writer = crate::configuration::ConfigurationWriter::acquire(
        &root.join("operation"),
        "JAVA_TASK_BUSY",
        "DOWNLOAD_STORAGE",
    )?;
    let lease = Arc::new(Lease {
        _busy: guard,
        _writer: writer,
    });
    let result = install(&app, &id, source, lease.clone()).await;
    drop(lease);
    (app.events)("java-components-changed", serde_json::Value::Null)?;
    result?;
    status(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_installation_keeps_verified_download_and_cleans_import_staging() {
        use sha2::{Digest, Sha256};
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let source = root.join("archive.zip");
        let bytes = b"verified archive with invalid zip contents";
        fs::write(&source, bytes).unwrap();
        let artifact = Artifact {
            version: "test".into(),
            filename: "maven.zip".into(),
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            url: "https://example.invalid/maven.zip".into(),
        };
        let components = Components::default();
        assert!(install_archive(
            root,
            "maven",
            &artifact,
            None,
            Some(source.clone()),
            &components,
        )
        .is_err());
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert!(install_archive(
            root,
            "maven",
            &artifact,
            Some(source.clone()),
            None,
            &components,
        )
        .is_err());
        assert_eq!(fs::read_dir(root).unwrap().count(), 2);
        assert_eq!(fs::read_dir(root.join("maven")).unwrap().count(), 0);
    }
    #[test]
    fn catalog_has_full_jdks_and_maven_without_bundled_archives() {
        let catalog: HashMap<String, HashMap<String, Artifact>> =
            serde_json::from_str(include_str!("../../../components/java/catalog.json")).unwrap();
        for target in ["windows-x64", "mac-x64", "mac-aarch64"] {
            for id in ["jdk-8", "jdk-11", "jdk-17", "jdk-21", "maven"] {
                let artifact = &catalog[target][id];
                assert!(artifact.url.starts_with("https://"));
                assert_eq!(artifact.sha256.len(), 64);
                assert!(artifact.size > 1_000_000 && artifact.size < 400_000_000);
            }
        }
    }
}
