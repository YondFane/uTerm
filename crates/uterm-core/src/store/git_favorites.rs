use super::{bounded_read, hash, retain_bytes, valid_revision, Store};
use crate::{CoreError, Result, MAX_REQUEST_BYTES};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::Path,
};

const PREFIX: &str = "uterm.git.favorites:";

#[derive(Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitFavoriteRepository {
    pub source_digest: Option<String>,
    pub references: Vec<String>,
    pub aliases: BTreeSet<String>,
}
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitFavoriteDocument {
    pub schema_version: u32,
    pub repositories: BTreeMap<String, GitFavoriteRepository>,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitFavorites {
    pub repository: String,
    pub revision: Option<String>,
    pub source_digest: Option<String>,
    pub references: Vec<String>,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitFavoriteRecoveryCatalog {
    pub current_revision: Option<String>,
    pub backups: Vec<String>,
    pub sources: Vec<String>,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
pub struct GitFavoriteRecoverySnapshot {
    pub revision: String,
    pub document: GitFavoriteDocument,
}
fn validate(references: &[String]) -> Result<()> {
    let mut unique = std::collections::BTreeSet::new();
    if references.len() > 1000
        || references.iter().any(|reference| {
            reference.len() > 32768
                || reference.contains(['\0', '\n', '\r'])
                || !(reference == "HEAD"
                    || ["refs/heads/", "refs/tags/", "refs/remotes/"]
                        .iter()
                        .any(|prefix| reference.starts_with(prefix)))
                || !unique.insert(reference)
        })
    {
        return Err(CoreError::new(
            "INVALID_FAVORITES",
            "Git favorites are invalid; original data was retained",
        ));
    }
    Ok(())
}
fn decode(bytes: &[u8]) -> Result<GitFavoriteDocument> {
    let document: GitFavoriteDocument = serde_json::from_slice(bytes).map_err(|error| {
        CoreError::new(
            "CORRUPT_FAVORITES",
            format!("Git favorites retained for recovery: {error}"),
        )
    })?;
    if document.schema_version != 1 {
        return Err(CoreError::new(
            "UNSUPPORTED_SCHEMA",
            "Git favorites schema is unsupported",
        ));
    }
    if document.repositories.len() > 1000 {
        return Err(CoreError::new(
            "FAVORITES_LIMIT",
            "Git favorite repository limit reached",
        ));
    }
    for (repository, entry) in &document.repositories {
        if !Path::new(repository).is_absolute()
            || repository.contains('\0')
            || entry
                .source_digest
                .as_deref()
                .is_some_and(|value| !valid_revision(value))
            || entry.aliases.len() > 32
            || entry.aliases.iter().any(|alias| {
                !Path::new(alias).is_absolute() || alias.len() > 32768 || alias.contains('\0')
            })
        {
            return Err(CoreError::new(
                "CORRUPT_FAVORITES",
                "Git favorite identity is invalid",
            ));
        }
        validate(&entry.references)?;
    }
    Ok(document)
}
fn snapshot(document: &GitFavoriteDocument, repository: &str) -> Result<GitFavorites> {
    let entry = document.repositories.get(repository);
    Ok(GitFavorites {
        repository: repository.into(),
        revision: entry
            .map(|entry| serde_json::to_vec(entry).map(|bytes| hash(&bytes)))
            .transpose()?,
        source_digest: entry.and_then(|entry| entry.source_digest.clone()),
        references: entry
            .map(|entry| entry.references.clone())
            .unwrap_or_default(),
    })
}

impl Store {
    fn favorites_current_bytes(&self) -> Result<Option<Vec<u8>>> {
        let path = self.root.join("git-favorites-v1.json");
        match fs::symlink_metadata(&path) {
            Ok(_) => bounded_read(&path).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    fn favorite_backup_bytes(&self, revision: &str) -> Result<Vec<u8>> {
        if !valid_revision(revision) {
            return Err(CoreError::new(
                "INVALID_ARGUMENT",
                "Invalid Git favorite recovery revision",
            ));
        }
        let bytes = bounded_read(&self.root.join(format!("git-favorites-{revision}.backup")))?;
        if hash(&bytes) != revision {
            return Err(CoreError::new(
                "CORRUPT_FAVORITES",
                "Git favorite recovery checksum differs; no data was replaced",
            ));
        }
        decode(&bytes)?;
        Ok(bytes)
    }
    pub fn favorites_recovery_catalog(&self) -> Result<GitFavoriteRecoveryCatalog> {
        let _guard = self.lock()?;
        let mut backups = Vec::new();
        let mut sources = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if let Some(revision) = name
                .strip_prefix("git-favorites-")
                .and_then(|name| name.strip_suffix(".backup"))
            {
                if self.favorite_backup_bytes(revision).is_ok() {
                    backups.push((entry.metadata()?.modified()?, revision.to_owned()));
                }
            } else if let Some(revision) = name
                .strip_prefix("git-favorite-source-")
                .and_then(|name| name.strip_suffix(".json"))
            {
                if valid_revision(revision)
                    && bounded_read(&entry.path()).is_ok_and(|bytes| {
                        hash(&bytes) == revision && std::str::from_utf8(&bytes).is_ok()
                    })
                {
                    sources.push(revision.to_owned());
                }
            }
        }
        backups.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        sources.sort();
        Ok(GitFavoriteRecoveryCatalog {
            current_revision: self.favorites_current_bytes()?.map(|bytes| hash(&bytes)),
            backups: backups.into_iter().map(|(_, revision)| revision).collect(),
            sources,
        })
    }
    pub fn favorites_recovery_preview(
        &self,
        revision: &str,
    ) -> Result<GitFavoriteRecoverySnapshot> {
        let _guard = self.lock()?;
        let bytes = self.favorite_backup_bytes(revision)?;
        Ok(GitFavoriteRecoverySnapshot {
            revision: revision.into(),
            document: decode(&bytes)?,
        })
    }
    pub fn favorites_recovery_source(&self, revision: &str) -> Result<String> {
        let _guard = self.lock()?;
        if !valid_revision(revision) {
            return Err(CoreError::new(
                "INVALID_ARGUMENT",
                "Invalid Git favorite source revision",
            ));
        }
        let bytes = bounded_read(
            &self
                .root
                .join(format!("git-favorite-source-{revision}.json")),
        )?;
        if hash(&bytes) != revision {
            return Err(CoreError::new(
                "CORRUPT_FAVORITES",
                "Git favorite source checksum differs; original data was retained",
            ));
        }
        String::from_utf8(bytes).map_err(|_| {
            CoreError::new(
                "CORRUPT_FAVORITES",
                "Git favorite source is not valid UTF-8; original data was retained",
            )
        })
    }
    pub fn favorites_recovery_restore(
        &self,
        revision: &str,
        expected: Option<&str>,
        expected_missing: bool,
    ) -> Result<GitFavoriteRecoverySnapshot> {
        let _guard = self.lock()?;
        let bytes = self.favorite_backup_bytes(revision)?;
        let current = self.favorites_current_bytes()?;
        if expected.is_some_and(|revision| !valid_revision(revision))
            || (expected_missing && expected.is_some())
            || (!expected_missing && expected.is_none())
        {
            return Err(CoreError::new("INVALID_ARGUMENT", "Git favorite restore requires an expected revision or explicit missing-store acknowledgement"));
        }
        let actual = current.as_deref().map(hash);
        let mut retained = BTreeSet::from([revision.to_owned()]);
        if actual.as_deref() != expected || current.is_none() != expected_missing {
            return Err(CoreError::new(
                "CONFLICT",
                "Git favorites changed after preview; choose the recovery copy again",
            ));
        }
        if let Some(current) = &current {
            let digest = hash(current);
            let suffix = if decode(current).is_ok() {
                "backup"
            } else {
                "damaged"
            };
            if suffix == "backup" {
                retained.insert(digest.clone());
            }
            retain_bytes(
                &self.root.join(format!("git-favorites-{digest}.{suffix}")),
                current,
            )?;
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        if self.favorites_current_bytes()?.as_deref().map(hash) != actual {
            return Err(CoreError::new(
                "CONFLICT",
                "Git favorites changed before recovery installation",
            ));
        }
        let path = self.root.join("git-favorites-v1.json");
        if expected_missing {
            temporary.persist_noclobber(path).map_err(|error| {
                if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                    CoreError::new(
                        "CONFLICT",
                        "Git favorites were created before recovery installation",
                    )
                } else {
                    CoreError::from(error.error)
                }
            })?;
        } else {
            temporary
                .persist(path)
                .map_err(|error| CoreError::from(error.error))?;
        }
        #[cfg(unix)]
        fs::File::open(&self.root)?.sync_all()?;
        self.favorites_prune_backups(&retained)?;
        Ok(GitFavoriteRecoverySnapshot {
            revision: revision.into(),
            document: decode(&bytes)?,
        })
    }
    fn favorites_originals(&self, repository: &str) -> Result<Vec<String>> {
        Ok(self
            .load()?
            .document
            .legacy
            .into_iter()
            .filter_map(|(key, raw)| {
                key.strip_prefix(PREFIX)
                    .is_some_and(|path| {
                        path == repository
                            || Path::new(path).canonicalize().ok().as_deref()
                                == Some(Path::new(repository))
                    })
                    .then_some(raw)
            })
            .collect())
    }
    fn favorites_load(&self) -> Result<GitFavoriteDocument> {
        let path = self.root.join("git-favorites-v1.json");
        match fs::symlink_metadata(&path) {
            Ok(_) => return decode(&bounded_read(&path)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        for entry in fs::read_dir(&self.root)? {
            let name = entry?.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("git-favorites-")
                && (name.ends_with(".backup") || name.ends_with(".damaged"))
            {
                return Err(CoreError::new("MISSING_FAVORITES", "Git favorites snapshot is missing; retain and restore a recovery copy before continuing"));
            }
        }
        Ok(GitFavoriteDocument {
            schema_version: 1,
            repositories: BTreeMap::new(),
        })
    }
    fn favorites_prune_backups(&self, retained: &BTreeSet<String>) -> Result<()> {
        let mut copies = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            if name
                .to_str()
                .and_then(|name| {
                    name.strip_prefix("git-favorites-")
                        .and_then(|name| name.strip_suffix(".backup"))
                })
                .is_some_and(|digest| {
                    valid_revision(digest)
                        && !retained.contains(digest)
                        && bounded_read(&entry.path())
                            .is_ok_and(|bytes| hash(&bytes) == digest && decode(&bytes).is_ok())
                })
            {
                copies.push((entry.metadata()?.modified()?, entry.path()));
            }
        }
        copies.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, path) in copies
            .into_iter()
            .skip(8usize.saturating_sub(retained.len()))
        {
            fs::remove_file(path)?;
        }
        Ok(())
    }
    fn favorites_save(
        &self,
        previous: &GitFavoriteDocument,
        document: &GitFavoriteDocument,
    ) -> Result<()> {
        let path = self.root.join("git-favorites-v1.json");
        let bytes = serde_json::to_vec_pretty(document)?;
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(CoreError::new(
                "FAVORITES_LIMIT",
                "Git favorites exceed the storage limit",
            ));
        }
        decode(&bytes)?;
        if fs::symlink_metadata(&path).is_ok() {
            let old = bounded_read(&path)?;
            if serde_json::to_value(decode(&old)?)? != serde_json::to_value(previous)? {
                return Err(CoreError::new(
                    "CONFLICT",
                    "Git favorites changed before backup; reload explicitly",
                ));
            }
            let revision = hash(&old);
            retain_bytes(
                &self.root.join(format!("git-favorites-{revision}.backup")),
                &old,
            )?;
            self.favorites_prune_backups(&BTreeSet::from([revision.clone()]))?;
        } else {
            let revision = hash(&bytes);
            retain_bytes(
                &self.root.join(format!("git-favorites-{revision}.backup")),
                &bytes,
            )?;
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(path)
            .map_err(|error| CoreError::from(error.error))?;
        #[cfg(unix)]
        fs::File::open(&self.root)?.sync_all()?;
        Ok(())
    }
    fn favorites_retain(&self, raw: &str) -> Result<String> {
        let digest = hash(raw.as_bytes());
        let path = self.root.join(format!("git-favorite-source-{digest}.json"));
        if !path.try_exists()?
            && fs::read_dir(&self.root)?
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("git-favorite-source-")
                })
                .count()
                >= 16
        {
            return Err(CoreError::new(
                "FAVORITES_SOURCE_LIMIT",
                "Git favorite recovery sources are full; no original data was removed",
            ));
        }
        retain_bytes(&path, raw.as_bytes())?;
        Ok(digest)
    }
    pub fn favorites_read(&self, repository: &str) -> Result<GitFavorites> {
        let _guard = self.lock()?;
        snapshot(&self.favorites_load()?, repository)
    }
    pub fn favorites_import(
        &self,
        repository: &str,
        alias: &str,
        legacy: Option<&str>,
    ) -> Result<GitFavorites> {
        let _guard = self.lock()?;
        let mut document = self.favorites_load()?;
        let previous = decode(&serde_json::to_vec(&document)?)?;
        let retained;
        let raw = if let Some(raw) = legacy {
            Some(raw)
        } else if document.repositories.contains_key(repository) {
            if document
                .repositories
                .get_mut(repository)
                .unwrap()
                .aliases
                .insert(alias.into())
            {
                self.favorites_save(&previous, &document)?;
            }
            return snapshot(&document, repository);
        } else {
            let mut originals = Vec::new();
            for raw in self.favorites_originals(repository)? {
                self.favorites_retain(&raw)?;
                originals.push(raw);
            }
            originals.sort();
            originals.dedup();
            if originals.len() > 1 {
                return Err(CoreError::new("FAVORITES_SOURCE_CONFLICT", "Multiple old Git favorite sources match this repository; originals were retained"));
            }
            retained = originals.pop();
            retained.as_deref()
        };
        let Some(raw) = raw else {
            return snapshot(&document, repository);
        };
        let digest = self.favorites_retain(raw)?;
        let references: Vec<String> = serde_json::from_str(raw).map_err(|error| {
            CoreError::new(
                "INVALID_FAVORITES",
                format!("Old Git favorites were retained but cannot be read: {error}"),
            )
        })?;
        validate(&references)?;
        if let Some(current) = document.repositories.get(repository) {
            if current.source_digest.as_deref() == Some(&digest) {
                if document
                    .repositories
                    .get_mut(repository)
                    .unwrap()
                    .aliases
                    .insert(alias.into())
                {
                    self.favorites_save(&previous, &document)?;
                }
                return snapshot(&document, repository);
            }
            return Err(CoreError::new(
                "FAVORITES_SOURCE_CONFLICT",
                "Old Git favorites differ from shared favorites; choose recovery data explicitly",
            ));
        }
        document.repositories.insert(
            repository.into(),
            GitFavoriteRepository {
                source_digest: Some(digest),
                references,
                aliases: BTreeSet::from([alias.into()]),
            },
        );
        self.favorites_save(&previous, &document)?;
        snapshot(&document, repository)
    }
    pub fn favorites_accept_shared(
        &self,
        repository: &str,
        alias: &str,
        legacy: &str,
    ) -> Result<GitFavorites> {
        let _guard = self.lock()?;
        let path = self.root.join(format!(
            "git-favorite-source-{}.json",
            hash(legacy.as_bytes())
        ));
        if bounded_read(&path)? != legacy.as_bytes() {
            return Err(CoreError::new(
                "FAVORITES_SOURCE_CONFLICT",
                "Retain the exact old Git favorite source before continuing",
            ));
        }
        let mut document = self.favorites_load()?;
        let previous = decode(&serde_json::to_vec(&document)?)?;
        if !document.repositories.contains_key(repository) {
            document.repositories.insert(
                repository.into(),
                GitFavoriteRepository {
                    source_digest: Some(hash(legacy.as_bytes())),
                    references: Vec::new(),
                    aliases: BTreeSet::new(),
                },
            );
        }
        document
            .repositories
            .get_mut(repository)
            .unwrap()
            .aliases
            .insert(alias.into());
        if serde_json::to_value(&document)? != serde_json::to_value(&previous)? {
            self.favorites_save(&previous, &document)?;
        }
        snapshot(&document, repository)
    }
    pub fn favorites_write(
        &self,
        repository: &str,
        alias: &str,
        expected: Option<&str>,
        references: Vec<String>,
    ) -> Result<GitFavorites> {
        validate(&references)?;
        let _guard = self.lock()?;
        let mut document = self.favorites_load()?;
        if !document.repositories.contains_key(repository)
            && !self.favorites_originals(repository)?.is_empty()
        {
            return Err(CoreError::new(
                "FAVORITES_NOT_IMPORTED",
                "Import old Git favorites before changing them",
            ));
        }
        if snapshot(&document, repository)?.revision.as_deref() != expected {
            return Err(CoreError::new(
                "CONFLICT",
                "Git favorites changed; reload before retrying",
            ));
        }
        let previous = decode(&serde_json::to_vec(&document)?)?;
        let entry = document.repositories.entry(repository.into()).or_default();
        entry.references = references;
        entry.aliases.insert(alias.into());
        self.favorites_save(&previous, &document)?;
        snapshot(&document, repository)
    }
    pub fn favorites_export(&self, legacy: &mut BTreeMap<String, String>) -> Result<()> {
        let _guard = self.lock()?;
        for (repository, entry) in self.favorites_load()?.repositories {
            let mut keys = legacy
                .keys()
                .filter(|key| {
                    key.strip_prefix(PREFIX).is_some_and(|path| {
                        path == repository
                            || Path::new(path).canonicalize().ok().as_deref()
                                == Some(Path::new(&repository))
                    })
                })
                .cloned()
                .collect::<Vec<_>>();
            keys.push(format!("{PREFIX}{repository}"));
            keys.extend(entry.aliases.iter().map(|alias| format!("{PREFIX}{alias}")));
            for key in keys {
                legacy.insert(key, serde_json::to_string(&entry.references)?);
            }
        }
        Ok(())
    }
}
