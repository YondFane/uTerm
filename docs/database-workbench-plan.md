---
title: Database workbench implementation plan
status: active
type: plan
created: 2026-10-15
updated: 2026-10-15
---

# Database workbench implementation plan

[简体中文](database-workbench-plan.zh-CN.md)

## Goal and boundaries

Build a lightweight workbench for finding objects, browsing data, writing SQL and handling transactions. Reuse React, CodeMirror, Tauri and the bundled JDBC worker. Keep Java and vendor drivers optional; do not bundle another editor, database server or large grid framework. Preserve active terminal sessions, credentials, connection identities, SQL drafts and transaction/exit guards. This plan describes intended work; [features.md](features.md) describes shipped behavior and actual validation.

## Phase 1 — basic workbench

Status: implemented. Windows native workbench and disposable MySQL validation pass; macOS/PostgreSQL/Oracle acceptance and a matching Release installer-size comparison remain pending. See the feature guide for exact coverage and limits.

- Replace flat metadata buttons with an object tree that filters loaded objects for the current connection. Reflect MySQL catalogs and PostgreSQL/Oracle schemas, group tables/views and collapse system objects.
- Separate the query editor/results from a table's Data and Structure views. Selecting objects never overwrites SQL or its results; generating SELECT requires an explicit action and preserves draft protection.
- Compact the connection/actions area. Add keyboard/pointer resizers for the object browser and SQL/results split, independent scrolling and a footer that remains visible. Preserve layouts and view state during connection/workspace switching in this run.
- Provide bounded, read-only table previews, cell/row/range selection, keyboard copying with optional headers, column resizing and full loaded-value inspection. Distinguish NULL, empty strings, binary and truncated values; separate result data from messages.
- Isolate metadata and table-preview reads from a writable connection's transaction. Reuse one lazy read-only browsing connection per workbench, keep resource limits and authentication/endpoint checks, close it with its owner and surface allocation/connection failures. Browsing must never commit or roll back SQL transactions.
- Retain conservative write confirmations, transaction and draft guards. Explain that cancellation closes the connection. No implicit SQL replay or default full-table count.

Acceptance: find student, open Data, inspect Structure, return to unchanged SQL/results, execute SQL and copy a range. Repeat while a write transaction is pending and verify browsing does not finish it. Check Windows at normal/narrow widths, pointer/keyboard resizing, fixed pagination, hidden workbench retention and visible failures. Record remaining platform/server limitations honestly.

## Phase 2 — SQL productivity

Planned: multiple query tabs with explicit session/transaction ownership; execute selection/current statement/all with dialect-aware parsing; SQL completion/formatting, error location and query history. Support commented SELECT and read-only CTEs without treating every WITH statement as read-only. History stays in memory by default; restart recovery is a separate explicit setting. Distinguish server-side table filters from filtering loaded arbitrary-query results.

## Phase 3 — controlled data maintenance

Planned: grid edits, insert/delete rows, SQL change preview, stale-data conflict checks, export and execution plans. Require a reliable unique key for editable results; otherwise remain read-only. Evaluate driver-supported cancellation that preserves the connection separately. Preserve explicit transaction handling and uncertain-write diagnostics.

## Size budget and validation

Estimated compressed installer increases, not measured outcomes:

| Phase | Increment  |
| ----- | ---------- |
| 1     | 0.1–0.4 MB |
| 2     | 0.2–0.8 MB |
| 3     | 0.2–0.8 MB |
| Total | 0.5–2 MB   |

Use the same OS, architecture, Release settings and packaging format for before/after comparisons. A cumulative 2 MB increase is a dependency-review checkpoint, not a guaranteed ceiling. Frontend gzip size is diagnostic and cannot substitute for an installer measurement. Extra connections primarily affect runtime memory; generated history/exports are user data, not installer resources. Validate frozen dependencies, changed-file formatting, localization/docs, frontend tests/build and relevant backend checks. Use isolated app identifiers for native QA and do not replace or restart an active installed app.

## Research references

- [DataGrip Database Explorer](https://www.jetbrains.com/help/datagrip/database-explorer.html): object hierarchy and navigation.
- [DBeaver Data Editor](https://dbeaver.com/docs/dbeaver/Data-Editor/): object data versus SQL result views.
- [TablePlus Editor Basics](https://tableplus.com/docs/query-editor/editor-basics): execution scope and compact query actions.
- [HeidiSQL help](https://www.heidisql.com/help.php?place=frmTableEditor): grouped objects and quick data filters.
- [DBeaver transaction modes](https://dbeaver.com/docs/dbeaver/Auto-and-Manual-Commit-Modes/): distinguish browsing, writes and transaction control.
