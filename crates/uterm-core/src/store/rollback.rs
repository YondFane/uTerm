use super::{EditorDraftSnapshot, Snapshot, Store};
use crate::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const DRAFT_KEY: &str = "uterm.desktop.editorDraft.v1";

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyDraftCandidate {
    pub directory: String,
    pub path: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackArchive {
    pub schema_version: u32,
    pub snapshot: Snapshot,
    pub editor: Option<EditorDraftSnapshot>,
    pub legacy_values: BTreeMap<String, String>,
    pub legacy_draft_candidates: Vec<LegacyDraftCandidate>,
    pub legacy_requires_draft_choice: bool,
    pub automatic_restore_allowed: bool,
}

impl Store {
    pub fn rollback_export(
        &self,
        expected: &str,
        expected_drafts: Option<&str>,
    ) -> Result<RollbackArchive> {
        // Read all stores under one writer lease; rollback must not mix different edit generations.
        // 在同一写入租约下读取各存储，回退不能混合不同编辑代次。
        let _guard = self.lock()?;
        let snapshot = self.load()?;
        if snapshot.revision != expected {
            return Err(CoreError::new(
                "CONFLICT",
                "Canonical state changed before rollback export",
            ));
        }
        let editor = match self.editor_load() {
            Ok(value) => Some(value),
            Err(error) if error.code == "DRAFTS_NOT_IMPORTED" => None,
            Err(error) => return Err(error),
        };
        if let Some(expected) = expected_drafts {
            if editor.as_ref().map(|value| value.revision.as_str()) != Some(expected) {
                return Err(CoreError::new(
                    "CONFLICT",
                    "Editor drafts changed before rollback export",
                ));
            }
        }
        let mut legacy_values = snapshot.document.legacy.clone();
        self.favorites_export_locked(&mut legacy_values)?;
        self.pdf_export_locked(&mut legacy_values)?;
        legacy_values.insert(
            "uterm.desktop.workspace.v1".into(),
            serde_json::to_string(&snapshot.document.workspace)?,
        );
        legacy_values.insert(
            "uterm.desktop.settings.v1".into(),
            serde_json::to_string(&snapshot.document.settings)?,
        );
        let legacy_draft_candidates = editor
            .as_ref()
            .map(|value| {
                value
                    .document
                    .drafts
                    .iter()
                    .map(|draft| {
                        Ok(LegacyDraftCandidate {
                            directory: draft.directory.clone(),
                            path: draft.path.clone(),
                            value: serde_json::to_string(draft)?,
                        })
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?
            .unwrap_or_default();
        if editor.is_some() {
            // Keep the original bytes in snapshot.document.legacy, never in the current single-draft slot.
            // 原始字节保留在 snapshot.document.legacy，不能占据当前单草稿槽。
            legacy_values.remove(DRAFT_KEY);
            if legacy_draft_candidates.len() == 1 {
                legacy_values.insert(DRAFT_KEY.into(), legacy_draft_candidates[0].value.clone());
            }
        }
        Ok(RollbackArchive {
            schema_version: 1,
            snapshot,
            editor,
            legacy_requires_draft_choice: legacy_draft_candidates.len() > 1,
            legacy_values,
            legacy_draft_candidates,
            automatic_restore_allowed: false,
        })
    }
}
