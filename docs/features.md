---
title: uTerm feature guide
status: active
type: reference
created: 2026-09-24
updated: 2026-09-27
---

# uTerm feature guide

[简体中文](features.zh-CN.md) · [Setup and commands](../README.en.md)

## Product scope

uTerm is a free Windows and macOS desktop terminal. All terminal and Agent processes run locally. The interface supports Simplified Chinese and English.

## Workspaces and sessions

Add Project supports selecting multiple folders in the native chooser. Review the selected paths and confirm Add to insert them into the workspace selected at confirmation. All directories are validated before the batch is saved; existing projects in that workspace are reused. Manual path entry replaces the multi-selection with a single path. Native multi-selection interaction remains pending runtime acceptance.

New chat from the welcome page, command palette or shortcut uses the selected project's directory (or selected Worktree directory) and belongs to that project. Without a selected project it uses the standalone chat directory. This routing uses the existing project-session creation flow; live Agent working-directory acceptance remains pending.

Background local-session discovery retries every two seconds after each attempt. Connection timeouts do not show an error banner; other synchronization failures remain visible. A timeout does not clear saved sessions. Focused automated tests cover timeout suppression and visibility of other failures; live timeout recovery remains unverified.

Workspaces contain projects, standalone terminals and chats. Projects can contain Git worktrees. Sessions support pinning, ordering, grouping, ungrouping, split resizing and directional focus. Groups cannot cross project, worktree or standalone collection boundaries.

The Rust local service owns PTYs and output replay. Quitting detaches the UI; Close Session terminates a process. Reconnection retains session identity and acknowledges replay in order. The service requires authentication and binds only to loopback. Running sessions prevent replacement of their service executable.

Workspace storage accepts schema version 3; settings accept version 1 and require valid current fields. Invalid or unsupported saved data produces an error without overwriting the original value. Startup reads only this application's workspace, without importing another application's state.

## Files and source control

Project and file-tree context menus offer Open in File Manager. Folders open directly; files are revealed in their containing folder. File-tree paths are checked against the selected root before opening. Native file-manager selection remains pending runtime acceptance.

Creation and renaming report conflicts separately for files and folders, including cross-type collisions. Renaming to the unchanged name succeeds without writing. Editing the input clears the previous validation message. Files and folders still cannot share a name in the same parent directory. Backend regression tests cover these rules; native interaction acceptance remains pending.

The file-panel footer and its tooltip display Windows paths without the extended-length prefix, preserving UNC server/share paths. Internal filesystem paths remain unchanged. Path-formatting tests cover drive and UNC paths; native visual acceptance remains pending.

New files and folders are named inline inside the target folder in the file tree; renaming edits the existing row. Enter confirms and Escape cancels; failures retain the input. Creation from a folder's context menu expands that folder. Refresh preserves expanded folders. Deletion still requires explicit confirmation. Native inline-edit focus and input-method acceptance remain unverified.

File access stays within the selected project root. Text saves check for conflicts and retain unsaved drafts for recovery. Markdown is sanitized before rendering; PDF canvas dimensions are bounded. Git views include status, diffs and commits, with worktree management. GitHub integration requires the user's credentials and access.

## Agents and settings

Agent definitions specify a program and argument list. Hooks report activity; usage can combine local logs with provider requests when enabled. Provider credentials and permissions determine availability. Terminal input and process I/O are handled independently of UI rendering.

Settings include appearance, color themes, fonts, terminal cursor and scrollback, keyboard shortcuts, default shell and Agent. Theme import accepts supported color fields only.

In a focused Windows terminal, Ctrl+C copies selected terminal text; without a selection it remains the terminal interrupt key. Ctrl+V and Ctrl+Shift+V paste clipboard text using the terminal's bracketed-paste mode when enabled. Ctrl+Shift+C also copies selected text. macOS uses Cmd+C/Cmd+V for clipboard operations and preserves Control keys for terminal programs. Clipboard failures are displayed in the session; a pending paste is discarded if its connection closes or changes.

## Interface

Central error banners hide after 1.5 seconds without clearing the underlying error state. A different message starts a new timer; unchanged background errors do not keep reopening the banner. Workspace-load retry remains available after the banner hides. Native timing acceptance remains pending.

Settings, the command palette and the Agent dialog close when a primary pointer click starts and ends outside their bounds. Internal clicks and drags starting inside do not dismiss them. Settings cannot be dismissed during update installation. Boundary tests cover inside/outside coordinates; native pointer interaction remains unverified.

Settings → General switches Simplified Chinese and English immediately, including open panels, menus, command search, validation messages, accessible labels and editor search controls. Switching language does not recreate terminal sessions or replace editor documents. Application-owned backend diagnostics are localized at display time; unknown OS/provider output, terminal content, filenames and user-entered names remain unchanged. Native operating-system dialog controls follow the OS language; the project chooser title follows the app language.

Missing message keys produce an explicit diagnostic marker and a deduplicated console error instead of silently returning Chinese. `pnpm i18n:check` rejects unregistered Chinese source literals, untranslated JSX text/accessibility attributes and invalid literal-key parameters. Tests verify all registered translations and placeholder parity, negative checker fixtures, live language subscriptions, all eight settings tabs and major panel rendering in both languages. Source analysis and mocked component tests are regression gates, not proof of every dynamic or native runtime state.

Settings → Appearance → Interface theme offers Black (black and silver, the default), Sandstone (warm charcoal and sand), Ocean (navy and ice blue), Moss (forest green and mint), Paper (warm white and terracotta), and Clear Sky (cool white and sky blue), with preview cards. Paper and Clear Sky always use light interface colors without changing terminal color-mode preferences. The other four support dark, light and system color modes. Selection applies immediately and saves automatically without changing terminal color selections or recreating sessions. Missing interface-theme settings default to Black; invalid values are rejected.

The interface uses warm charcoal surfaces, a restrained sand accent, fine dividers and compact controls, with a matching light palette. Sidebar selection, terminal pane focus and inspector tabs use consistent states. A welcome page offers project, terminal and chat actions with configured shortcut hints; unavailable actions are disabled. Empty inspectors do not reserve screen space. UI colors and terminal ANSI colors are independent, and reduced-motion preferences are respected. See [DESIGN.md](../DESIGN.md) for tokens and design references.

## Architecture

The file editor and its Markdown/syntax dependencies load on demand, with loading and failure states. Unchanged Git branch polls preserve React state identity. PDF thumbnails render near the viewport and release offscreen canvas buffers. The development server streams local PDF resources instead of retaining all resource bytes in memory; production retains the complete PDF resources for offline compatibility. Key resource-lifetime decisions have English/Chinese comments.

React components live in `src/components/`; state and pure logic in `src/lib/`; Tauri commands in `src-tauri/src/`; PTYs, replay and hooks in `crates/utermd-local/`. The backend and session service use separate Cargo manifests and lockfiles.

## Validation and limits

Performance validation: 119 frontend/build-helper tests, localization checks and the TypeScript/production build pass. The main JavaScript chunk measures 909.45 kB versus a 1,343.64 kB baseline (approximately 32% smaller); this is startup chunk size, not total installer size. Total installer reduction and runtime CPU/RSS improvements have not been measured. Deferred-editor failure/recovery and offscreen PDF rendering still need desktop interaction checks; the >500 kB chunk warning remains.

Localization validation on Windows: 119 frontend/build-helper tests, 29 backend tests and the TypeScript/production build pass. An isolated browser preview of the real settings components verifies English → Chinese → English without reload and the translated reset button. Component tests mock desktop APIs and terminal/PDF rendering; live native dialogs, tray interactions, authenticated provider states and macOS localization still require runtime acceptance. The running desktop app is not restarted for these checks.

Theme validation: frontend/build-helper tests and TypeScript checks pass, including settings round-trips, invalid values and text contrast for all palettes. An isolated browser preview of the real settings components verifies Ocean selection, Moss light rendering and persistence after reload. Black, Paper and Clear Sky visual acceptance, desktop theme-switching interaction and macOS acceptance remain unverified.

Automated checks cover state validation, session identity and layout, file recovery, input handling, build helpers, Rust backend and local service behavior. Run the commands in the README on the target OS.

Current Windows verification: frozen dependency installation, formatting, documentation checks, localization source checks, 119 frontend/build-helper tests, 14 local-service tests, 29 backend tests and the frontend production build pass. The desktop executable is not rebuilt while the user's app is running; native runtime localization acceptance remains pending. Shortcut tests cover selection-dependent copying, Control interrupt passthrough, paste keys, macOS modifiers and composition/AltGr exclusion. Clipboard shortcuts in live Claude/Codex sessions still require interactive verification. The frontend build reports a bundle-size warning for chunks above 500 kB.

The Windows app was built and visually inspected in a separate design-QA window. Browser checks cover the welcome page at 680×500 without overflow and light-palette rendering. Full keyboard, split-pane, file/editor/dialog and macOS visual acceptance remains unverified.

Interactive Windows/macOS acceptance, installer execution, credential-dependent GitHub/provider calls and signed updates require separate runtime checks. Browser preview does not exercise desktop commands. Unix-only PTY tests do not run on Windows.
