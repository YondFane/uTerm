use super::{bounded_read, hash, retain_bytes, valid_revision, Store};
use crate::{CoreError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, collections::BTreeSet, fs, io::Write, path::PathBuf};

const PREFIX: &str = "pdf-marks-";

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Target {
    directory: String,
    path: String,
    version: String,
}
impl Target {
    fn validate(&self) -> Result<()> {
        if self.directory.is_empty()
            || self.directory.len() > 32768
            || self.directory.contains('\0')
            || self.path.is_empty()
            || self.path.len() > 32768
            || self.path.contains('\0')
            || self.path.starts_with(['/', '\\'])
            || (self.path.as_bytes().get(1) == Some(&b':'))
            || self.path.split(['/', '\\']).any(|part| part == "..")
            || !valid_revision(&self.version)
        {
            return Err(CoreError::new(
                "INVALID_PARAMS",
                "Invalid PDF highlight target",
            ));
        }
        Ok(())
    }
    fn id(&self) -> Result<String> {
        Ok(hash(&serde_json::to_vec(self)?))
    }
    fn legacy_key(&self) -> String {
        format!(
            "uterm.pdf.marks:{}/{}:{}",
            self.directory, self.path, self.version
        )
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Mark {
    id: String,
    page: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
fn validate_marks(marks: &[Mark]) -> Result<()> {
    let mut ids = BTreeSet::new();
    if marks.len() > 2000
        || marks.iter().any(|mark| {
            mark.id.is_empty()
                || mark.id.len() > 200
                || mark.id.contains('\0')
                || mark.page == 0
                || !ids.insert(&mark.id)
                || [mark.x, mark.y, mark.width, mark.height]
                    .iter()
                    .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
                || mark.x + mark.width > 1.0 + 1e-8
                || mark.y + mark.height > 1.0 + 1e-8
        })
    {
        return Err(CoreError::new(
            "INVALID_PDF_MARKS",
            "Invalid PDF highlights; original retained",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    schema_version: u32,
    target: Target,
    marks: Vec<Mark>,
}
fn decode(bytes: &[u8]) -> Result<Document> {
    let document: Document = serde_json::from_slice(bytes).map_err(|_| {
        CoreError::new(
            "CORRUPT_PDF_MARKS",
            "PDF highlights are unreadable; original retained",
        )
    })?;
    if document.schema_version != 1 {
        return Err(CoreError::new(
            "UNSUPPORTED_SCHEMA",
            "PDF highlight schema is unsupported",
        ));
    }
    document.target.validate()?;
    validate_marks(&document.marks)?;
    Ok(document)
}

impl Store {
    fn pdf_path(&self, target: &Target) -> Result<PathBuf> {
        Ok(self.root.join(format!("{PREFIX}{}.json", target.id()?)))
    }
    fn pdf_load(&self, target: Target) -> Result<(Document, Vec<u8>, bool)> {
        let path = self.pdf_path(&target)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                let bytes = bounded_read(&path)?;
                let document = decode(&bytes)?;
                if document.target != target {
                    return Err(CoreError::new(
                        "CORRUPT_PDF_MARKS",
                        "PDF highlight identity differs; original retained",
                    ));
                }
                Ok((document, bytes, true))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let prefix = format!("{PREFIX}{}-", target.id()?);
                for entry in fs::read_dir(&self.root)? {
                    let name = entry?.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with(&prefix) && name.ends_with(".backup") {
                        return Err(CoreError::new(
                            "MISSING_PDF_MARKS",
                            "PDF highlights are missing; restore a recovery copy explicitly",
                        ));
                    }
                }
                let saved = self.load()?;
                let marks: Vec<Mark> = saved
                    .document
                    .legacy
                    .get(&target.legacy_key())
                    .map(|raw| {
                        serde_json::from_str(raw).map_err(|_| {
                            CoreError::new(
                                "CORRUPT_PDF_MARKS",
                                "Original PDF highlights are unreadable; source retained",
                            )
                        })
                    })
                    .transpose()?
                    .unwrap_or_default();
                validate_marks(&marks)?;
                let document = Document {
                    schema_version: 1,
                    target,
                    marks,
                };
                let bytes = serde_json::to_vec_pretty(&document)?;
                Ok((document, bytes, false))
            }
            Err(error) => Err(error.into()),
        }
    }
    pub(crate) fn pdf_marks_request(&self, method: &str, params: Value) -> Result<Value> {
        if method == "pdf.marks.read" {
            let target: Target = serde_json::from_value(params).map_err(|_| {
                CoreError::new("INVALID_PARAMS", "Invalid PDF highlight read request")
            })?;
            target.validate()?;
            let _guard = self.lock()?;
            let (document, bytes, _) = self.pdf_load(target)?;
            return Ok(serde_json::json!({"revision":hash(&bytes),"marks":document.marks}));
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Request {
            directory: String,
            path: String,
            version: String,
            expected_revision: String,
            marks: Vec<Mark>,
        }
        let request: Request = serde_json::from_value(params)
            .map_err(|_| CoreError::new("INVALID_PARAMS", "Invalid PDF highlight write request"))?;
        let target = Target {
            directory: request.directory,
            path: request.path,
            version: request.version,
        };
        target.validate()?;
        validate_marks(&request.marks)?;
        if !valid_revision(&request.expected_revision) {
            return Err(CoreError::new(
                "INVALID_PARAMS",
                "Invalid PDF highlight revision",
            ));
        }
        let _guard = self.lock()?;
        let (mut document, previous, exists) = self.pdf_load(target)?;
        if hash(&previous) != request.expected_revision {
            return Err(CoreError::new(
                "CONFLICT",
                "PDF highlights changed; retain the selection and retry explicitly",
            ));
        }
        if document.marks == request.marks {
            return Ok(serde_json::json!({"revision":hash(&previous),"marks":document.marks}));
        }
        if exists {
            let backup = self.root.join(format!(
                "{PREFIX}{}-{}.backup",
                document.target.id()?,
                request.expected_revision
            ));
            retain_bytes(&backup, &previous)?;
            self.pdf_prune_backups(&document.target, &backup)?;
        }
        document.marks = request.marks;
        let bytes = serde_json::to_vec_pretty(&document)?;
        let mut file = tempfile::NamedTempFile::new_in(&self.root)?;
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        let path = self.pdf_path(&document.target)?;
        let result = if exists {
            file.persist(path)
        } else {
            file.persist_noclobber(path)
        };
        result.map_err(|error| CoreError::from(error.error))?;
        #[cfg(unix)]
        fs::File::open(&self.root)?.sync_all()?;
        Ok(serde_json::json!({"revision":hash(&bytes),"marks":document.marks}))
    }
    fn pdf_prune_backups(&self, target: &Target, retained: &std::path::Path) -> Result<()> {
        let prefix = format!("{PREFIX}{}-", target.id()?);
        let mut older = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name
                .strip_prefix(&prefix)
                .and_then(|value| value.strip_suffix(".backup"))
                .is_some_and(valid_revision)
                && entry.path() != retained
                && entry.file_type()?.is_file()
            {
                older.push((entry.metadata()?.modified()?, entry.path()));
            }
        }
        older.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, path) in older.into_iter().skip(7) {
            fs::remove_file(path)?;
        }
        Ok(())
    }
    pub(super) fn pdf_export_locked(&self, legacy: &mut BTreeMap<String, String>) -> Result<()> {
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(PREFIX) || !name.ends_with(".json") {
                continue;
            }
            let document = decode(&bounded_read(&entry.path())?)?;
            if entry.path() != self.pdf_path(&document.target)? {
                return Err(CoreError::new(
                    "CORRUPT_PDF_MARKS",
                    "PDF highlight filename differs; source retained",
                ));
            }
            legacy.insert(
                document.target.legacy_key(),
                serde_json::to_string(&document.marks)?,
            );
        }
        Ok(())
    }
    pub(crate) fn pdf_export(&self, legacy: &mut BTreeMap<String, String>) -> Result<()> {
        let _guard = self.lock()?;
        self.pdf_export_locked(legacy)
    }
}
