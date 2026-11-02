use super::{bounded_read, hash, retain_bytes, valid_revision, Store};
use crate::{CoreError, Result, MAX_REQUEST_BYTES};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, io::Write};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct EditorDraft {
    pub directory: String,
    pub path: String,
    pub kind: String,
    pub text: String,
    pub saved: String,
    pub version: String,
    pub line_ending: String,
    pub bom: bool,
}
impl EditorDraft {
    fn validate(&self) -> Result<()> {
        if self.kind != "text"
            || self.directory.is_empty()
            || self.directory.len() > 32768
            || self.directory.contains('\0')
            || self.path.is_empty()
            || self.path.len() > 32768
            || self.path.contains('\0')
            || self.path.starts_with(['/', '\\'])
            || (self.path.as_bytes().get(1) == Some(&b':')
                && self.path.as_bytes()[0].is_ascii_alphabetic())
            || self.path.split(['/', '\\']).any(|part| part == "..")
            || self.text.encode_utf16().count() > 2 * 1024 * 1024
            || self.saved.encode_utf16().count() > 2 * 1024 * 1024
            || self.version.len() != 64
            || !self
                .version
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || !["\n", "\r\n", "\r"].contains(&self.line_ending.as_str())
        {
            return Err(CoreError::new(
                "INVALID_DRAFT",
                "Editor draft is invalid; recovery source was retained",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorDraftDocument {
    pub schema_version: u32,
    pub source_digest: Option<String>,
    pub drafts: Vec<EditorDraft>,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
pub struct EditorDraftSnapshot {
    pub revision: String,
    pub document: EditorDraftDocument,
}
fn decode(bytes: &[u8]) -> Result<EditorDraftDocument> {
    let document: EditorDraftDocument = serde_json::from_slice(bytes).map_err(|e| {
        CoreError::new(
            "CORRUPT_DRAFTS",
            format!("Draft storage retained for recovery: {e}"),
        )
    })?;
    if document.schema_version != 1 {
        return Err(CoreError::new(
            "UNSUPPORTED_SCHEMA",
            "Editor draft schema is unsupported",
        ));
    }
    if document
        .source_digest
        .as_deref()
        .is_some_and(|s| !valid_revision(s))
        || document.drafts.len() > 100
    {
        return Err(CoreError::new(
            "CORRUPT_DRAFTS",
            "Invalid editor draft metadata",
        ));
    }
    let mut keys = BTreeSet::new();
    for draft in &document.drafts {
        draft.validate()?;
        if !keys.insert((&draft.directory, &draft.path)) {
            return Err(CoreError::new(
                "CORRUPT_DRAFTS",
                "Duplicate editor draft identity",
            ));
        }
    }
    Ok(document)
}
impl Store {
    fn editor_load(&self) -> Result<EditorDraftSnapshot> {
        let path = self.root.join("editor-drafts-v1.json");
        if fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
            return Err(CoreError::new(
                "DRAFTS_NOT_IMPORTED",
                "Import editor recovery data before editing",
            ));
        }
        let bytes = bounded_read(&path)?;
        Ok(EditorDraftSnapshot {
            revision: hash(&bytes),
            document: decode(&bytes)?,
        })
    }
    pub fn editor_read(&self) -> Result<EditorDraftSnapshot> {
        let _guard = self.lock()?;
        self.editor_load()
    }
    pub fn editor_import(&self, legacy: Option<&str>) -> Result<EditorDraftSnapshot> {
        let _guard = self.lock()?;
        let digest = legacy.map(|text| hash(text.as_bytes()));
        if let (Some(raw), Some(digest)) = (legacy, &digest) {
            if raw.len() > MAX_REQUEST_BYTES {
                return Err(CoreError::new(
                    "REQUEST_TOO_LARGE",
                    "Legacy draft exceeds recovery limit; source unchanged",
                ));
            }
            let source = self
                .root
                .join(format!("editor-draft-source-{digest}.original"));
            if !source.exists() {
                let count = fs::read_dir(&self.root)?
                    .filter_map(|entry| entry.ok())
                    .filter(|entry| {
                        entry.file_name().to_str().is_some_and(|name| {
                            name.starts_with("editor-draft-source-") && name.ends_with(".original")
                        })
                    })
                    .count();
                if count >= 16 {
                    return Err(CoreError::new(
                        "DRAFT_SOURCE_LIMIT",
                        "Recovery sources are full; retain the new source before proceeding",
                    ));
                }
            }
            retain_bytes(&source, raw.as_bytes())?;
        }
        match fs::symlink_metadata(self.root.join("editor-drafts-v1.json")) {
            Ok(_) => {
                let current = self.editor_load()?;
                if current.document.source_digest == digest {
                    return Ok(current);
                }
                return Err(CoreError::new(
                    "MIGRATION_CONFLICT",
                    "Editor recovery already exists; both sources were retained",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let drafts = match legacy {
            Some(raw) => {
                let draft: EditorDraft = serde_json::from_str(raw).map_err(|e| {
                    CoreError::new(
                        "INVALID_DRAFT",
                        format!("Original editor draft retained: {e}"),
                    )
                })?;
                draft.validate()?;
                vec![draft]
            }
            None => vec![],
        };
        self.editor_persist(&EditorDraftDocument {
            schema_version: 1,
            source_digest: digest,
            drafts,
        })?;
        self.editor_load()
    }
    pub fn editor_put(&self, expected: &str, draft: EditorDraft) -> Result<EditorDraftSnapshot> {
        draft.validate()?;
        self.editor_update(expected, |document| {
            let existing = document
                .drafts
                .iter()
                .any(|entry| entry.directory == draft.directory && entry.path == draft.path);
            if !existing && document.drafts.len() >= 100 {
                return Err(CoreError::new(
                    "DRAFT_LIMIT",
                    "Draft collection is full; retain local text before closing a document",
                ));
            }
            document
                .drafts
                .retain(|entry| entry.directory != draft.directory || entry.path != draft.path);
            document.drafts.push(draft);
            document
                .drafts
                .sort_by(|a, b| (&a.directory, &a.path).cmp(&(&b.directory, &b.path)));
            Ok(())
        })
    }
    pub fn editor_remove(
        &self,
        expected: &str,
        directory: &str,
        path: &str,
    ) -> Result<EditorDraftSnapshot> {
        self.editor_update(expected, |document| {
            document
                .drafts
                .retain(|entry| entry.directory != directory || entry.path != path);
            Ok(())
        })
    }
    fn editor_update(
        &self,
        expected: &str,
        change: impl FnOnce(&mut EditorDraftDocument) -> Result<()>,
    ) -> Result<EditorDraftSnapshot> {
        let _guard = self.lock()?;
        let mut current = self.editor_load()?;
        if current.revision != expected {
            return Err(CoreError::new(
                "CONFLICT",
                "Drafts changed; retain local text and reload before retrying",
            ));
        }
        let previous = current.document.clone();
        change(&mut current.document)?;
        if current.document == previous {
            return Ok(current);
        }
        let bytes = serde_json::to_vec_pretty(&current.document)?;
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(CoreError::new(
                "REQUEST_TOO_LARGE",
                "Draft storage exceeds the bounded limit; original retained",
            ));
        }
        decode(&bytes)?;
        let path = self.root.join("editor-drafts-v1.json");
        let previous = bounded_read(&path)?;
        if hash(&previous) != expected {
            return Err(CoreError::new(
                "CONFLICT",
                "Draft storage changed before backup",
            ));
        }
        retain_bytes(
            &self.root.join(format!("editor-drafts-{expected}.backup")),
            &previous,
        )?;
        self.editor_prune_backups(expected)?;
        self.editor_persist(&current.document)?;
        self.editor_load()
    }
    fn editor_persist(&self, document: &EditorDraftDocument) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(document)?;
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(CoreError::new(
                "REQUEST_TOO_LARGE",
                "Draft storage exceeds the bounded limit; original retained",
            ));
        }
        let mut file = tempfile::NamedTempFile::new_in(&self.root)?;
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        file.persist(self.root.join("editor-drafts-v1.json"))
            .map_err(|e| CoreError::from(e.error))?;
        #[cfg(unix)]
        fs::File::open(&self.root)?.sync_all()?;
        Ok(())
    }
    fn editor_prune_backups(&self, retained: &str) -> Result<()> {
        let mut old = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            if name
                .to_str()
                .and_then(|s| {
                    s.strip_prefix("editor-drafts-")
                        .and_then(|s| s.strip_suffix(".backup"))
                })
                .is_some_and(|revision| {
                    valid_revision(revision)
                        && revision != retained
                        && bounded_read(&entry.path())
                            .is_ok_and(|bytes| hash(&bytes) == revision && decode(&bytes).is_ok())
                })
                && entry.file_type()?.is_file()
            {
                old.push((entry.metadata()?.modified()?, entry.path()));
            }
        }
        old.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, path) in old.into_iter().skip(7) {
            fs::remove_file(path)?;
        }
        Ok(())
    }
    pub fn editor_recovery_list(&self) -> Result<serde_json::Value> {
        let _guard = self.lock()?;
        let mut backups = Vec::new();
        let mut sources = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if let Some(revision) = name
                .strip_prefix("editor-drafts-")
                .and_then(|s| s.strip_suffix(".backup"))
            {
                if valid_revision(revision)
                    && bounded_read(&entry.path())
                        .is_ok_and(|bytes| hash(&bytes) == revision && decode(&bytes).is_ok())
                {
                    backups.push(revision.to_string());
                }
            } else if let Some(revision) = name
                .strip_prefix("editor-draft-source-")
                .and_then(|s| s.strip_suffix(".original"))
            {
                if valid_revision(revision)
                    && bounded_read(&entry.path()).is_ok_and(|bytes| hash(&bytes) == revision)
                {
                    sources.push(revision.to_string());
                }
            }
        }
        backups.sort();
        sources.sort();
        let current = bounded_read(&self.root.join("editor-drafts-v1.json"))
            .map(|bytes| hash(&bytes))
            .ok();
        Ok(serde_json::json!({"currentRevision":current,"backups":backups,"sources":sources}))
    }
    pub fn editor_recover(&self, expected: &str, revision: &str) -> Result<EditorDraftSnapshot> {
        let _guard = self.lock()?;
        if !valid_revision(revision) {
            return Err(CoreError::new(
                "INVALID_ARGUMENT",
                "Unknown editor recovery copy",
            ));
        }
        let current = bounded_read(&self.root.join("editor-drafts-v1.json"))?;
        if hash(&current) != expected {
            return Err(CoreError::new(
                "CONFLICT",
                "Draft storage changed during recovery",
            ));
        }
        let saved = bounded_read(&self.root.join(format!("editor-drafts-{revision}.backup")))?;
        if hash(&saved) != revision {
            return Err(CoreError::new(
                "CORRUPT_DRAFTS",
                "Editor recovery checksum differs",
            ));
        }
        let document = decode(&saved)?;
        retain_bytes(
            &self
                .root
                .join(format!("editor-drafts-{}.damaged", hash(&current))),
            &current,
        )?;
        self.editor_persist(&document)?;
        self.editor_load()
    }
}
