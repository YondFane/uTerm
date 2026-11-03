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

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    source_digest: Option<String>,
    references: Vec<String>,
    aliases: BTreeSet<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    schema_version: u32,
    repositories: BTreeMap<String, Entry>,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitFavorites {
    pub repository: String,
    pub revision: Option<String>,
    pub source_digest: Option<String>,
    pub references: Vec<String>,
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
fn decode(bytes: &[u8]) -> Result<Document> {
    let document: Document = serde_json::from_slice(bytes).map_err(|error| {
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
fn snapshot(document: &Document, repository: &str) -> Result<GitFavorites> {
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
    fn favorites_load(&self) -> Result<Document> {
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
        Ok(Document {
            schema_version: 1,
            repositories: BTreeMap::new(),
        })
    }
    fn favorites_save(&self, previous: &Document, document: &Document) -> Result<()> {
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
                            && digest != revision
                            && bounded_read(&entry.path())
                                .is_ok_and(|bytes| hash(&bytes) == digest && decode(&bytes).is_ok())
                    })
                {
                    copies.push((entry.metadata()?.modified()?, entry.path()));
                }
            }
            copies.sort_by(|a, b| b.0.cmp(&a.0));
            for (_, path) in copies.into_iter().skip(7) {
                fs::remove_file(path)?;
            }
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
            Entry {
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
                Entry {
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
