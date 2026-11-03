use crate::{state, CoreError, Result, MAX_REQUEST_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
mod editor;
mod git_favorites;
pub use editor::{
    EditorDraft, EditorDraftCollection, EditorDraftDocument, EditorDraftEntry, EditorDraftSnapshot,
    EditorRecoveryCatalog,
};
pub use git_favorites::GitFavorites;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    pub schema_version: u32,
    pub migration_id: String,
    pub workspace: Value,
    pub settings: Value,
    pub legacy: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Snapshot {
    pub revision: String,
    pub document: Document,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Import {
    pub workspace: Value,
    pub settings: Value,
    pub legacy: BTreeMap<String, String>,
}

pub struct Store {
    root: PathBuf,
}
struct WriterGuard(File);
impl Drop for WriterGuard {
    fn drop(&mut self) {
        // Closing one descriptor does not release a flock inherited during PTY spawning.
        // 只关闭一个描述符不会释放 PTY 创建期间继承的 flock。
        loop {
            match self.0.unlock() {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    eprintln!("Canonical writer unlock: {error}");
                    break;
                }
            }
        }
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
impl Store {
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self {
            root: root.canonicalize()?,
        })
    }
    fn lock(&self) -> Result<WriterGuard> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join("writer.lock"))?;
        loop {
            match file.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::Error(error))
                    if error.kind() == std::io::ErrorKind::Interrupted =>
                {
                    continue
                }
                Err(std::fs::TryLockError::WouldBlock) => {
                    return Err(CoreError::new(
                        "WRITER_BUSY",
                        "Another writer owns the canonical store",
                    ))
                }
                Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
            }
        }
        Ok(WriterGuard(file))
    }
    fn path(&self) -> PathBuf {
        self.root.join("snapshot-v1.json")
    }
    fn load(&self) -> Result<Snapshot> {
        let path = self.path();
        let metadata = fs::symlink_metadata(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                CoreError::new("NOT_IMPORTED", "No canonical snapshot has been imported")
            } else {
                e.into()
            }
        })?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_REQUEST_BYTES as u64
        {
            return Err(CoreError::new(
                "CORRUPT_STORE",
                "Canonical snapshot has an invalid file type or size; the original was retained",
            ));
        }
        let bytes = fs::read(path)?;
        let document: Document = serde_json::from_slice(&bytes).map_err(|e| {
            CoreError::new(
                "CORRUPT_STORE",
                format!("Snapshot retained for recovery: {e}"),
            )
        })?;
        if document.schema_version != 1 {
            return Err(CoreError::new(
                "UNSUPPORTED_SCHEMA",
                "Canonical schema is not supported",
            ));
        }
        state::validate_workspace(&document.workspace)?;
        state::validate_settings(&document.settings)?;
        Ok(Snapshot {
            revision: hash(&bytes),
            document,
        })
    }
    pub fn read(&self) -> Result<Snapshot> {
        let _lock = self.lock()?;
        self.load()
    }
    pub fn recovery_list(&self) -> Result<Value> {
        let _lock = self.lock()?;
        let current = bounded_read(&self.path()).map(|bytes| hash(&bytes)).ok();
        let mut backups = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Some(revision) = name
                .strip_prefix("snapshot-")
                .and_then(|n| n.strip_suffix(".backup"))
            else {
                continue;
            };
            if valid_revision(revision)
                && bounded_read(&entry.path())
                    .and_then(|bytes| {
                        if hash(&bytes) != revision {
                            return Err(CoreError::new("CORRUPT_STORE", "Backup checksum differs"));
                        }
                        decode(&bytes)
                    })
                    .is_ok()
            {
                backups.push(revision.to_string());
            }
        }
        backups.sort();
        Ok(serde_json::json!({"currentRevision":current,"backups":backups}))
    }
    pub fn recover(&self, expected: &str, revision: &str) -> Result<Snapshot> {
        let _lock = self.lock()?;
        if !valid_revision(revision) {
            return Err(CoreError::new(
                "INVALID_ARGUMENT",
                "Unknown recovery snapshot",
            ));
        }
        let current = bounded_read(&self.path())?;
        if hash(&current) != expected {
            return Err(CoreError::new(
                "CONFLICT",
                "Snapshot changed during recovery",
            ));
        }
        let bytes = bounded_read(&self.root.join(format!("snapshot-{revision}.backup")))?;
        if hash(&bytes) != revision {
            return Err(CoreError::new("CORRUPT_STORE", "Backup checksum differs"));
        }
        let document = decode(&bytes)?;
        let damaged = self
            .root
            .join(format!("snapshot-{}.damaged", hash(&current)));
        retain_bytes(&damaged, &current)?;
        self.persist(&document)?;
        self.load()
    }
    pub fn import(&self, input: Import) -> Result<Snapshot> {
        let _lock = self.lock()?;
        let source = serde_json::to_vec(&input.legacy)?;
        if source.len() > MAX_REQUEST_BYTES {
            return Err(CoreError::new(
                "REQUEST_TOO_LARGE",
                "Legacy export exceeds the bounded import limit; source is unchanged",
            ));
        }
        let migration_id = hash(&source);
        if self.path().exists() {
            let current = self.load()?;
            if current.document.migration_id == migration_id {
                return Ok(current);
            }
            return Err(CoreError::new(
                "MIGRATION_CONFLICT",
                "Canonical state already exists; a new legacy export cannot overwrite it",
            ));
        }
        state::validate_workspace(&input.workspace)?;
        state::validate_settings(&input.settings)?;
        let document = Document {
            schema_version: 1,
            migration_id,
            workspace: input.workspace,
            settings: input.settings,
            legacy: input.legacy,
        };
        let backup = self.root.join("legacy-original.json");
        if backup.exists() {
            if bounded_read(&backup)? != source {
                return Err(CoreError::new(
                    "MIGRATION_CONFLICT",
                    "A different interrupted migration backup exists",
                ));
            }
        } else {
            write_new(&backup, &source)?;
        }
        self.persist(&document)?;
        self.load()
    }
    pub fn update(
        &self,
        expected: &str,
        change: impl FnOnce(&mut Document) -> Result<()>,
    ) -> Result<Snapshot> {
        let _lock = self.lock()?;
        let mut snapshot = self.load()?;
        if snapshot.revision != expected {
            return Err(CoreError::new(
                "CONFLICT",
                "Snapshot changed; retain the draft and reload explicitly",
            ));
        }
        change(&mut snapshot.document)?;
        state::validate_workspace(&snapshot.document.workspace)?;
        state::validate_settings(&snapshot.document.settings)?;
        if snapshot.document == self.load()?.document {
            return Ok(snapshot);
        }
        let recovery = self
            .root
            .join(format!("snapshot-{}.backup", snapshot.revision));
        let previous = bounded_read(&self.path())?;
        if hash(&previous) != snapshot.revision {
            return Err(CoreError::new("CONFLICT", "Snapshot changed before backup"));
        }
        retain_bytes(&recovery, &previous)?;
        let mut backups = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name
                .strip_prefix("snapshot-")
                .and_then(|n| n.strip_suffix(".backup"))
                .is_some_and(valid_revision)
                && entry.file_type()?.is_file()
                && entry.path() != recovery
            {
                backups.push((entry.metadata()?.modified()?, entry.path()));
            }
        }
        backups.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, path) in backups.into_iter().skip(7) {
            fs::remove_file(path)?;
        }
        self.persist(&snapshot.document)?;
        self.load()
    }
    fn persist(&self, document: &Document) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(document)?;
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(CoreError::new(
                "REQUEST_TOO_LARGE",
                "Canonical snapshot exceeds the bounded storage limit",
            ));
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(self.path())
            .map_err(|e| CoreError::from(e.error))?;
        #[cfg(unix)]
        File::open(&self.root)?.sync_all()?;
        Ok(())
    }
}
fn valid_revision(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn bounded_read(path: &Path) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_REQUEST_BYTES as u64
    {
        return Err(CoreError::new(
            "CORRUPT_STORE",
            "Invalid recovery file; retained unchanged",
        ));
    }
    Ok(fs::read(path)?)
}
fn decode(bytes: &[u8]) -> Result<Document> {
    let document: Document = serde_json::from_slice(bytes)
        .map_err(|e| CoreError::new("CORRUPT_STORE", e.to_string()))?;
    if document.schema_version != 1 {
        return Err(CoreError::new(
            "UNSUPPORTED_SCHEMA",
            "Canonical schema is not supported",
        ));
    }
    state::validate_workspace(&document.workspace)?;
    state::validate_settings(&document.settings)?;
    Ok(document)
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn retain_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            if bounded_read(path)? != bytes {
                return Err(CoreError::new(
                    "CORRUPT_STORE",
                    "Existing recovery copy differs; retained unchanged",
                ));
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => write_new(path, bytes),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_guard_releases_ownership_even_while_a_descriptor_copy_survives() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path().to_owned()).unwrap();
        let guard = store.lock().unwrap();
        let inherited = guard.0.try_clone().unwrap();
        assert!(matches!(store.lock(), Err(error) if error.code == "WRITER_BUSY"));
        drop(guard);
        assert!(
            store.lock().is_ok(),
            "A descriptor copy retained the completed transaction lock"
        );
        drop(inherited);
    }
}
