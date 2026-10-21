---
title: uTerm feature guide
status: active
type: reference
created: 2026-09-24
updated: 2026-10-21
---

# uTerm feature guide

[简体中文](features.zh-CN.md) · [Download and quick start](../README.md) ·
[Development](development.md)

**Contents**

- [Product scope](#product-scope)
- [Project website](#project-website)
- [Installation](#installation)
- [Workspaces and sessions](#workspaces-and-sessions)
- [SSH and remote files](#ssh-and-remote-files)
- [Redis connections and workbench](#redis-connections-and-workbench)
- [Files and source control](#files-and-source-control)
- [Agents and settings](#agents-and-settings)
- [Interface](#interface)
- [Architecture](#architecture)
- [Validation and limits](#validation-and-limits)
- [Database connections and optional components](#database-connections-and-optional-components)

## Product scope

uTerm is a Windows and macOS desktop terminal. Local terminal and Agent processes run locally; SSH
remote shells run on their servers.

The interface supports Simplified Chinese and English.

## Project website

### Website preview

The independent GitHub Pages website in `site/` introduces terminals and agents, projects and Git,
SSH/SFTP, and Redis/databases. Its four tabs are labeled illustrations with sample content, not live
desktop sessions or server connections.

Six interface palettes change only the preview. English/Simplified Chinese switching updates
content, accessible labels, metadata and documentation links; a blocked browser storage setting does
not prevent switching.

Keyboard users can navigate tabs with arrow keys, Home and End.

### Repository guides and presentation media

The repository opens with an English README; its language link opens `README.zh-CN.md`.
`README.en.md` remains an identical English compatibility copy. Downloads and a three-step quick
start precede the detailed feature and development guides.

The README and website show an actual isolated Windows app screenshot with a disposable project, two
real local shells and a Git Worktree. The website's video and interactive five-step tour explain
that screenshot; the 30-second GIF/MP4 are annotated screenshot tours, not continuous recordings.
They do not demonstrate model requests or remote connections.

Reusable media and its provenance live in `site/media/`. The editable social card and PNG support
website sharing metadata; GitHub's repository social preview must be uploaded separately.

### Downloads and installation commands

Windows x64, macOS Apple Silicon and macOS Intel download links initially open the stable GitHub
release. When the public latest-release API succeeds, they resolve to the exact matching installer
assets from this repository.

Missing assets, rate limits or network failure retain the release-page fallback. Installation tabs
expose the existing npm/macOS/PowerShell commands; copying reports success or selects the command
with visible manual-copy guidance when clipboard access fails.

SQL and MongoDB use require Java 17+ and the selected drivers; Elasticsearch requires no additional
runtime, and macOS first launch may require Privacy & Security approval.

### Local preview and publication

Run `pnpm site:dev` for a loopback-only preview under `/uTerm/`; `pnpm site:check` runs focused
interaction checks. The Pages workflow uploads only `site/` from `release`; repository Pages must
use GitHub Actions and the `github-pages` environment must allow that branch.

Publication requires the reviewed website changes to reach `release`. Local browser checks do not
establish hosted Pages deployment or desktop runtime acceptance.

#### Website checks on Windows

- Website validation on Windows: all seven focused checks pass, together with changed-file
  formatting, script syntax, local documentation links and documentation metadata/index checks. The
  updated release skill passes its skill validator.

- Browser inspection covers Chinese/English, 1280×720, 768×1024 and 390×844 layouts without page
  overflow, the screenshot tour and actual MP4 playback. Public release metadata resolves to the
  three matching stable installers; focused checks also cover download fallbacks, preview tabs,
  palettes, keyboard navigation and installation-command copying.

- The preview serves the explicit website/media allowlist and rejects repository-file paths.
  Bilingual README/development pages are inspected at wide and narrow reading widths.

- An isolated Windows native QA app provides the screenshot using actual product components and
  disposable sessions. Its frontend and desktop builds pass, with the existing large-chunk warning.
  The media does not establish macOS/Linux, authenticated Agent, SSH or database acceptance.

- The Pages workflow publishes the presentation from `release`; local checks alone do not verify
  hosted publication or GitHub's separately configured social preview.

## Installation

### Stable releases

The repository sidebar’s Latest entry points to the stable installer release. The release workflow
marks a version Latest only after public downloads are verified and the stable update feed is
published.

The prerelease update channel is never marked Latest.

The release skill requires notes to start with `# uTerm MAJOR.MINOR.PATCH`, followed by matching
Chinese and English feature highlights and usage instructions. Release preparation checks that this
heading matches the application version, notes filename and release tag; publication verification
also checks the heading in the release body and stable update feed.

After an authorized stable release passes CI, public-download, stable-feed and Latest verification,
the release skill requires merging its published commit into `main` and pushing it. The workflow
preserves both histories, excludes later unpublished commits and checks remote ancestry. Branch
protection or unresolved conflicts leave synchronization explicitly incomplete.

#### Build dependency caches

PR/branch CI and stable-release jobs cache the pnpm store and Cargo dependencies, including compiled
dependencies under both `src-tauri/target` and `crates/utermd-local/target`. Rust debug/test and
release artifacts remain separate. Cargo cache keys account for the runner image, CPU architecture,
Rust compiler, build environment and both workspaces' manifests/lockfiles; pnpm keys include the OS,
architecture, pnpm major version and `pnpm-lock.yaml`.

The `uTerm build cache` workflow runs after pushes to `main`, or manually with `main` selected. It
checks out `release` and compiles test targets and the release desktop application without running
tests or packaging installers on macOS ARM64, macOS Intel and Windows x64.

This seeds caches in the default branch's scope for later version tags; GitHub does not share caches
between different tags. Prewarming consumes additional CI runner time and does not sign or publish a
release.

Cache hits never skip frozen dependency installation, formatting, documentation checks, tests,
source/tag validation, signing or public-download/update-feed checks. A missing or expired cache
falls back to a normal build; first runs and compiler changes can still require cold compilation.

#### Stable-release checks

- Cache configuration validation on macOS passes actionlint, workflow/Markdown and repository
  formatting, documentation metadata/index checks and 284 frontend/build-helper tests (ten skipped).
  Parsed workflow comparisons confirm that all existing CI/release checks, triggers and permissions
  remain unchanged, and prewarming uses matching cache settings and release platforms. Remote cache
  restore/save and timing improvements await a workflow run; Windows cache-path execution has not
  been tested locally.

- Release preparation on macOS passes frozen dependency installation, 284 frontend/build-helper
  tests (ten skipped), 114 backend tests (nine ignored) and 46 host tests (two native CLI tests
  ignored). TypeScript/production build, desktop compilation, repository formatting, localization
  and documentation checks pass. This does not establish Windows/Linux runtime acceptance.

- Latest validation: six release-helper tests, workflow formatting, step-order and shell syntax
  checks, and documentation checks pass. The live latest-release API resolves to a published stable
  release, with its name, notes and all 11 uploaded asset records intact.

- Release skill structure, Markdown formatting and documentation checks pass. Version-heading
  matching is reviewed during release preparation and publication verification.

### One-line installation

The [README](../README.md#one-line-installation) provides one-line Terminal and PowerShell commands
backed by `scripts/install/install.sh` and `scripts/install/install.ps1`. They read the platform
stable update feed and download the matching versioned installer over HTTPS from this repository.
macOS selects Apple Silicon or Intel, including Rosetta detection, mounts the DMG read-only and
installs to `~/Applications/uTerm.app` without sudo or launching the app.

Existing user/system installations are preserved; use in-app updates. Windows x64 opens the
installation wizard and reports unsuccessful exit codes.

Installer payloads make at most three download attempts. With installer size and SHA-256 in the
stable feed, interrupted payloads are retained and resumed, and complete cached files are verified
before reuse.

Older feeds remain usable through fresh downloads without persistent payload reuse. Temporary
mount/staging files are cleaned up; verified installer caches retain up to four files and remove
inactive files older than seven days on subsequent use.

Windows uses a cache lock; macOS uses a lock directory that may need manual removal after a forced
termination. Failures print the official manual-download page.

GitHub access is required; no development toolchain is needed. Apple notarization is unavailable,
and first launch may require Privacy & Security approval.

The commands require the scripts to be published on `release`.

### npm installation command

The standalone npm package in `scripts/install` exposes `uterm-install` through npx, pnpm dlx or a
global installation. Node.js 22.13 or newer is required.

It invokes the bundled platform script with separate arguments and no shell interpolation,
preserving installer exit status. Help and invalid arguments never start installation.

There are no install lifecycle hooks; installing/removing the npm package only manages the command,
not the desktop application. The package is published on npm as `@yondfane/uterm-install`.

#### Installer checks and pending acceptance

- Validation: all 150 frontend/build-helper tests, 39 backend tests, local-session service tests,
  locked dependency installation, formatting, localization, documentation checks and
  TypeScript/production and desktop builds pass on macOS. Shell syntax and mocked macOS installer
  tests cover native/Rosetta architecture selection, paths with spaces, unsupported platforms,
  malformed versions, download failure and existing-install protection.

- The npm entry test covers platform dispatch, separate arguments, help, invalid input and failure
  exit status. A locally packed tarball passes both npm exec and pnpm dlx help smoke tests on macOS;
  npm pack confirms both platform scripts are included.

- The published npm 0.1.0 package also passes npx and pnpm dlx help checks. These tests do not
  download or install an application.

- Actual macOS installation and Windows PowerShell/runtime acceptance remain unverified.

## Workspaces and sessions

### Project and Worktree rows

Project and Worktree rows keep their folder icons when hovered or focused, with no separate dropdown
button. Their inline actions show New terminal and enabled Agents, without a More actions (ellipsis)
button; right-click the row for its existing menu.

When inline space is insufficient, the terminal/Agent capsule opens to the right of the row and can
extend beyond the sidebar. Folder icons and names retain their space; wider rows keep the capsule
inline.

Left-click the icon, name or remaining row-label space to expand or collapse the children;
Enter/Space on the focused row performs the same action. Existing project/session selection and
editor transition guards remain in effect.

Right-click menus, dragging and the row's quick-action buttons do not toggle folding. Active-tree
folding stays in memory, while inactive project/Worktree folding retains its existing saved setting;
activity rings remain visible when folded.

#### Project-action checks on Windows

- Project-action validation on Windows: six existing sidebar checks, changed-source formatting,
  localization/documentation checks and TypeScript/production build pass. An isolated native
  Tauri/WebView2 host (`sh.uterm.desktop.qa.hidemore`) renders the real Sidebar with temporary
  state.

- Visual inspection covers absent ellipsis buttons on active project, Worktree and inactive project
  rows, Chinese/dark 248 px and English/light 176 px layouts, correct right-click target callbacks
  and retained terminal/Agent quick actions. The fixture does not launch sessions; full-application
  menu integration and macOS/Linux runtime acceptance remain unverified.

- The production build retains its large-chunk warning.

#### Folder-row checks on Windows

- Folder-row validation on Windows: both focused sidebar regressions pass, covering row toggling,
  independent Worktrees, retained activity rings, unchanged active-tree saved settings,
  inactive-folder persistence, drag-click suppression, right-click/quick-action isolation and
  pending-transition guards. Changed source/style/test formatting, localization,
  TypeScript/production build and documentation checks pass.

- An isolated native Tauri/WebView2 QA host (`sh.uterm.desktop.qa.sidebarmenus`) renders the real
  Sidebar with temporary state and verifies icon/name clicks, no hover arrow, Enter/Space,
  right-click and quick actions, saved inactive folding, dark/light appearance and a 176 px sidebar
  in Chinese/English. This verifies Sidebar layout and callbacks without starting real sessions or
  restarting the installed app.

- Full-application editor transitions and macOS/Linux runtime acceptance remain unverified; the
  production build retains its large-chunk warning.

### Close and Remove buttons

Sidebar session Close Session buttons and SSH/Redis/database Remove buttons appear only while their
row is hovered or contains keyboard focus. Selection alone does not keep them visible.

Hidden buttons ignore pointer input and retain their space, so row labels do not shift; keyboard
navigation still reveals the controls.

#### Close-button visibility checks

- Close-button visibility validation: two focused sidebar/connection regressions, changed-source
  formatting, localization/documentation checks and TypeScript/production build pass. An isolated
  Windows Tauri/WebView2 host (`sh.uterm.desktop.qa.sidebarclose`) renders the real Sidebar and
  verifies all five fixture rows hiding/showing on pointer entry/exit, unchanged label bounds, a
  selected mouse-focused row hiding after pointer exit, keyboard focus/Enter activation, disabled
  connection controls and dark/light appearance with both languages.

- Callbacks use temporary fixtures without launching or terminating sessions or connecting to
  servers. macOS/Linux runtime acceptance remains pending; the production build retains its existing
  large-chunk warning.

### Connection context menus

Right-click an SSH connection row for New SSH terminal and Edit SSH connection; right-click a Redis
or database connection row to edit its profile. These actions no longer appear as inline
plus/ellipsis buttons.

Section Add buttons and row Remove buttons remain available. Opening a menu does not select or
connect its target.

Existing session, transfer, connection and draft protections still disable editing. Shift+F10 or the
Menu key opens the focused row's menu; arrows and Home/End navigate available actions, and Escape
returns focus to the row.

Menus stay within the window and close on outside input, scrolling, resize, loss of window focus,
hiding/folding the section, changing workspace or removing the target.

#### Connection-menu checks on Windows

- Connection-menu validation on Windows: the focused regression and three existing sidebar
  regressions pass, covering target identity, no selection on right-click, live edit guards,
  bilingual labels, keyboard focus/navigation and stale-target dismissal. Changed-source/test
  formatting, localization, documentation and TypeScript/production build pass.

- An isolated native Tauri/WebView2 QA host (`sh.uterm.desktop.qa.sidebarmenus`) renders the real
  Sidebar with temporary profiles and verifies hidden inline actions, right-click menus, all four
  action targets, arrows/Escape and returned focus, Chinese/English labels, dark/light appearance, a
  176 px sidebar, window-edge placement and protected editing. This covers WebView layout and
  callbacks; it does not connect to servers or validate the complete application lifecycle.
  macOS/Linux menu acceptance remains incomplete.

- The existing large-chunk build warning remains. The installed application was not restarted.

### Resource activity rings

Sidebar project, Worktree, SSH, Redis and database icons keep their normal colors while in use; only
their outer ring and soft glow turn green. Projects count all unclosed terminal/Agent sessions,
including those in Worktrees; each Worktree counts only its own sessions.

- SSH profiles count unclosed SSH sessions. Idle or exited sessions still count until closed.

- A registered Worktree without sessions and a merely selected profile do not light up. Redis and
  database rings require a successful connected state; opening, disconnected, busy or dirty state
  alone does not qualify.

- Rings disappear after the last session closes or a connection disconnects, remain visible when a
  project is folded, and use a darker green in light mode. Accessible descriptions identify open
  sessions or a connection.

- This steady indicator is separate from the blinking unread-completion hint on session icons.

#### Resource-ring checks

- Resource-ring validation: 217 frontend/build-helper tests pass, with eight optional Java/database
  checks skipped; the final focused sidebar regressions also pass. Changed source/test formatting,
  localization, documentation checks, TypeScript, the production frontend build and an isolated
  macOS desktop build pass.

- Native QA (`sh.uterm.desktop.qa.resourcerings`) renders the real Sidebar with isolated fixture
  state and verifies green rings for all five resource types, dark/light contrast, retained
  indication when folded, disappearance after sessions/connections close, and single-line name
  truncation at 176 px. The fixtures do not connect to servers; live SSH/Redis/database and
  Windows/Linux runtime acceptance remain pending.

#### Ring-color checks on Windows

- Ring-color validation on Windows: the focused activity-state regression, changed-style formatting,
  documentation checks and TypeScript/production build pass. An isolated Tauri/WebView2 host
  (`sh.uterm.desktop.qa.sidebarclose`) verifies all five resource types in dark/light mode: active
  icons and Redis glyph borders retain their inactive colors, while only the outer ring and glow are
  green.

- Folding retains the ring and original icon color. The fixture uses no real sessions or server
  connections; macOS/Linux runtime acceptance remains pending.

### Section folding and bulk actions

Sidebar section headings, including Active, Pinned, SSH, Redis, Databases and Projects, let you
click the name, arrow or remaining blank space across the full heading height to expand or collapse
the section independently. Enter/Space on the focused heading performs the same action.

- Right-side Add, database-component and bulk expand/collapse buttons act independently without
  toggling the section. Sections start expanded; folding is kept for the current app run and
  retained when the footer hides and shows a section.

- Folding only hides the sidebar entries, preserving SSH sessions, connected workbenches, selection,
  drafts and transactions. Add buttons and database-component management remain available while
  folded.

- The bulk expand/collapse button appears only when its section contains project or Worktree
  folders; an empty Projects section retains its heading and Add project entry.

#### Bulk-action visibility checks

- Bulk-action visibility validation: rendering the actual Sidebar component confirms that the action
  is absent with no projects, appears enabled after adding a project, still folds its folders, and
  disappears after the last project is removed. Five sidebar tests, TypeScript and changed-source
  formatting pass.

- Native visual acceptance of this visibility rule remains pending.

#### Section-heading checks on Windows

- Section-heading validation on Windows: all six focused sidebar checks, changed-style formatting,
  localization, documentation checks and TypeScript/production build pass. An isolated native
  Tauri/WebView2 QA host (`sh.uterm.desktop.qa.sidebarmenus`) renders the real Sidebar with
  temporary state and verifies all six headings: blank-space clicks at the top/bottom of the
  full-height button, independent folding, name/arrow clicks, Enter/Space, right-click isolation,
  independent Add/component/bulk actions, retained sessions/profiles/selection and retained folding
  after hiding/showing.

- Chinese/dark 248 px and English/light 176 px layouts pass visual inspection. The fixtures do not
  start real sessions, connect to servers or open application dialogs; full-application integration
  and macOS/Linux acceptance of the expanded click area remain unverified.

- The focused suite retains existing Vite WebSocket-port warnings, and the production build retains
  its large-chunk warning.

### Connection visibility switches

The Classic sidebar footer provides separate icon-only buttons to show or hide connection sections:
a terminal window for SSH, three stacked square layers for Redis and a cylinder for databases. Hover
labels describe the action, and accessible names identify each connection type.

- All three sections are visible by default, including for older saved settings; highlighted icons
  indicate visible sections, while hidden sections use muted icons. The three choices are saved
  independently as application settings, apply across workspaces and persist after restart.

- Highlight colors follow the interface theme by default. Settings → Appearance → Icon highlight can
  apply a custom color to these switches and the inspector tool switcher.

- Hiding a section retains its profiles, SSH sessions and active Redis/database workbenches,
  connections, drafts and database transactions. If saving a preference fails, the previous
  visibility is retained and an error appears.

- The footer wraps its controls when the sidebar is narrow.

The Icon navigation sidebar always offers all three connection categories and their lists,
regardless of these saved switches. Switching back to Classic sidebar restores the saved choices.

### Adding connections from the footer

The footer's + menu offers Add SSH connection, Add Redis connection and Add database connection
alongside Add project, New terminal and enabled Agent chats. In Classic sidebar, each connection
item follows its section's visibility switch: hiding the section hides its Add item, and showing it
restores that item independently. Icon navigation sidebar always offers all three connection items.

Collapsing a visible section keeps its Add item available. Choosing an item closes the menu and
opens the existing connection dialog.

The menu fits within the sidebar and wraps long labels when narrow.

#### Connection-switch and Add-menu checks

- Connection controls and Add-menu validation on Windows: all six focused sidebar checks,
  changed-file formatting, localization, documentation checks and TypeScript/production build pass.
  Regression coverage includes all eight visibility combinations, legacy defaults, independent
  choices, provider reload, retained profiles/sessions/selection, visible storage failures,
  bilingual labels and a single correct Add callback with menu dismissal.

- An isolated native Tauri/WebView2 host (`sh.uterm.desktop.qa.sidebarmenus`) renders the real
  Sidebar with temporary profiles and verifies all eight combinations through footer clicks, adding
  while folded, each callback and dismissal, keyboard navigation/Enter/Escape and returned focus.
  Chinese/dark 248 px and English/light 176 px menus with both enabled Agent chats pass visual
  inspection; narrow labels wrap completely within the sidebar.

- The fixture does not open real connection dialogs or connect to servers; full-application dialog
  integration and macOS/Linux acceptance of the expanded menu remain unverified. Vite WebSocket-port
  and production large-chunk warnings remain.

### Middle-click to Close Session

Middle-click a sidebar session row or a terminal pane's title to Close Session, terminating that
session's process through the existing close flow. This works for project, Worktree, pinned and
standalone terminal/Agent sessions.

Middle-click does not select the sidebar target or trigger its context menu; terminal content
retains its existing mouse behavior. Close failures remain visible and retain the session for retry.

#### Validation and limits

- Windows validation: 158 frontend/build-helper tests pass, with two platform-specific tests
  skipped; 40 backend tests, 16 local-service tests, locked dependency installation,
  TypeScript/production build, localization and documentation checks pass. Component regression
  coverage includes project terminals, Agents, Worktrees and standalone terminals/chats,
  default-event suppression and right-button exclusion.

- Native Windows/macOS mouse acceptance remains pending. The production build retains its
  large-chunk warning.

### Active project tree

The sidebar’s Active section shows complete project trees for projects in the current workspace with
unclosed terminal or Agent sessions, including idle and Worktree sessions. Each project appears only
once, with its sessions and all Worktrees beneath it; no session count is shown.

- Pinned projects, Worktrees and sessions join the same active tree while retaining their pin flags
  and ordering. Closing the last session returns the project and its children to their original
  Projects/Pinned sections.

- Active is hidden when no projects have sessions; standalone terminals and chats stay in their own
  sections. Active projects and Worktrees with sessions initially expand, with separate in-memory
  folding that does not overwrite the original folder settings.

- Section-wide folding affects only that section; project dragging stays within the same section and
  pin status. Selecting an active project retains its selected session or opens its first stored
  session; selecting a session or a Worktree with sessions uses the editor save/close guard and is
  disabled during pending transitions.

- Project removal stays disabled until every session closes. Session and workspace changes update
  the tree immediately.

### Project paths and workspace moves

Project context menus offer Copy project path for the absolute local directory and Move to
workspace, whose submenu lists other workspaces by name. Hover, click or Right Arrow expands it;
Up/Down selects a destination and Left Arrow/Escape returns to the parent menu.

- The submenu opens toward the available space near window edges and scrolls for long lists. With no
  other workspace, moving is disabled.

- Moving changes workspace membership only, preserving project files and sessions. New Worktree
  remains in the project menu; New terminal and Refresh Worktrees are not offered there.

- Terminal creation remains available through the toolbar, welcome page and shortcuts, and Worktrees
  are discovered automatically when projects load. Clipboard failures remain visible.

### Next and Previous workspace

Use Next workspace and Previous workspace in the command palette or Settings → Keyboard shortcuts.
The defaults are Cmd+Option+] / Cmd+Option+[ on macOS and Ctrl+Alt+] / Ctrl+Alt+[ on Windows. macOS
also lists both commands in the Workspace menu. Shortcuts can be customized or disabled; an existing
custom binding takes precedence over a new default that uses the same keys.

Switching follows the workspace list order, includes empty workspaces and wraps at either end. Each
workspace remembers its project, Worktree and session selection. With fewer than two workspaces,
both commands are unavailable.

Switching from a file uses the existing save/conflict and draft protections. Dialogs and pending
editor transitions block the shortcuts; switching is also available from Redis/database views.
Sessions remain running. Storage failures show an error and retain the current workspace.

#### Workspace shortcut checks

- Focused regression checks cover both platform modifiers, custom/disabled bindings, existing
  binding precedence, list order, empty workspaces, wrapping and selection restoration. App checks
  exercise actual keyboard events, native menu commands, dialog/repeat/composition guards and
  storage failures with mocked desktop services.

- On macOS, all 40 focused checks and 276 frontend/build-helper tests pass, with ten
  optional/platform checks skipped in the full suite. Formatting, localization,
  TypeScript/production and isolated desktop builds pass; the production build retains its
  large-chunk warning.

- Native QA (`sh.uterm.desktop.qa.workspaceshortcuts`) verifies both shortcuts and wrapping between
  two empty workspaces, disabled menu commands with one workspace, the Chinese shortcut settings
  layout and settings-dialog blocking. Windows/Linux runtime and native file-save/Redis/database
  switching remain unverified.

### Closing a session in another workspace

Close Session brings its target workspace and session into view before requesting termination,
including targets in other workspaces. Each invocation closes only one session; a failed close
retains the target for retry.

#### Validation and limits

- Regression tests cover draining another workspace's project, Worktree, standalone terminal and
  chat sessions. Native cross-workspace shortcut acceptance remains pending.

### Next and Previous session

Next session and Previous session cycle across all workspaces in stored workspace order, visiting
project sessions and then standalone terminals/chats within each workspace. Empty workspaces are
skipped and both directions wrap around.

- Navigation selects the destination workspace, project and Worktree together and remembers the
  previous workspace selection. With no active session it selects the first/last session in the
  current workspace, falling back to all workspaces.

- Editor and pending-transition guards remain active.

#### Validation and limits

- Regression tests cover cross-workspace navigation, wrapping, empty collections and selection
  restoration; native shortcut acceptance remains pending.

### Agent exit and close failures

Agent chats close automatically only on a successful exit (code 0), removing the chat pane and
sidebar entry after final output acknowledgement and successful host cleanup. Failed or unknown
exits retain diagnostics, as do ordinary shell terminals.

A failed Close Session retains the attachment and retries must confirm termination before removing
it; disconnected sessions may require reconnection first. Disconnection alone does not close a chat;
acknowledgement or cleanup failures remain visible.

Native Claude/Codex exit acceptance remains pending.

### Close Session shortcut order

Close Session closes one session per shortcut invocation: the active session in the selected
project, then its remaining sessions (including Worktrees), then other projects in stored order and
finally standalone sessions across workspaces. With no project selected, an active standalone
session takes priority.

When a file is displayed, the same Close Session shortcut (Cmd+W on macOS, Ctrl+W on Windows by
default) closes that file tab first, saving changes through the existing conflict/draft guard
without terminating a session. It is disabled during a pending file transition/dialog, or when
neither a file nor sessions remain.

#### Validation and limits

- Sequence tests cover draining all collections; an App shortcut regression test covers saving and
  removing the active file while preserving sessions. Native shortcut acceptance remains pending.

### Adding multiple projects

Add Project supports selecting multiple folders in the native chooser. Review the selected paths and
confirm Add to insert them into the workspace selected at confirmation.

All directories are validated before the batch is saved; existing projects in that workspace are
reused. Manual path entry replaces the multi-selection with a single path.

Native multi-selection interaction remains pending runtime acceptance.

### New chat working directory

New chat from the welcome page, command palette or shortcut uses the selected project's directory
(or selected Worktree directory) and belongs to that project. Without a selected project it uses the
standalone chat directory.

This routing uses the existing project-session creation flow; live Agent working-directory
acceptance remains pending.

### Background session discovery

Background local-session discovery retries every two seconds after each attempt. Connection timeouts
do not show an error banner; other synchronization failures remain visible.

A timeout does not clear saved sessions.

#### Validation and limits

- Focused automated tests cover timeout suppression and visibility of other failures; live timeout
  recovery remains unverified.

### Session grouping

Workspaces contain projects, standalone terminals and chats. Projects can contain Git worktrees.

Sessions support pinning, ordering, grouping, ungrouping, split resizing and directional focus.
Groups cannot cross project, worktree or standalone collection boundaries.

### Detachment and reconnection

The Rust local service owns PTYs and output replay. Quitting detaches the UI; Close Session
terminates a process.

Reconnection retains session identity and acknowledges replay in order. The service requires
authentication and binds only to loopback.

Running sessions prevent replacement of their service executable.

### Saved workspace data

Workspace storage uses schema version 7, accepts versions 3, 4, 5 and 6 and retains each original
version backup before saving upgraded data; settings accept version 1 and require valid current
fields. Invalid or unsupported saved data produces an error without overwriting the original value.

Startup reads only this application's workspace, without importing another application's state.

### Agent detection in shell sessions

Ordinary shell sessions on macOS and Windows recognize descendant Claude/Codex executables and
display their Agent icon in the sidebar. Unix process snapshots retain full executable paths even
beyond the default ps column width; a real subprocess regression covers a long path with spaces.

Detection refreshes at most once per second; exiting the Agent restores the terminal icon. Only
executable names `claude`/`codex` (or their Windows `.exe` names) are recognized; Node.js wrappers
and custom Agent names are not identified.

#### Validation and limits

- Process-tree tests cover session isolation, ambiguous matches, paths with spaces and clearing
  identity after exit; all local-service tests, formatting, documentation checks and
  frontend/desktop builds pass on macOS. Native icon switching and Windows runtime acceptance remain
  unverified.

### Removing a saved connection

Removing an SSH, Redis or database connection opens a confirmation dialog showing the connection
name and explaining that its saved profile and remembered password will be deleted. Only Confirm
removal starts removal; Cancel or Escape keeps the profile and password and returns focus to the
entry.

Cancel receives initial focus. Existing session, file, transfer, connection, draft and
SSH-dependency protections still apply.

A pending confirmation is cancelled if the profile changes, becomes protected, disappears, the
workspace changes or the sidebar/connection section is hidden.

#### Connection-removal checks

- Connection-removal validation: five connection-related frontend regressions pass. Focused
  component coverage includes all three connection types in Simplified Chinese and English,
  cancellation, Escape, initial/returned focus, a single callback after confirmation, live
  protection changes and invalidated targets.

- An isolated Windows desktop app (`sh.uterm.desktop.qa.connectionremoval`) verifies both languages,
  Cancel/Escape preserving saved profiles, returned focus and confirmed profile removal for all
  three types using disposable profiles without credentials or server connections. Dark/light
  dialogs and long-name wrapping pass visual inspection.

- Frozen dependency installation, changed-file formatting, localization/documentation checks,
  TypeScript/production build and the isolated desktop build pass. The full frontend suite
  encountered a Vite SSR module-loading timeout.

- Remembered-credential integration and macOS/Linux runtime acceptance remain unverified; the
  production build retains its large-chunk warning.

## SSH and remote files

### Connection setup

The sidebar’s SSH connections belong to the current workspace. Add a connection using a host
address, port (default 22), username, remote system (Linux/macOS or Windows) and optional file root.

- Choose Host address or OpenSSH configuration. Authentication defaults to OpenSSH automatic
  selection. More settings contains the optional connection name, remote system and file root; a
  blank name uses the host. Save only stores the profile; Save and connect stores it before creating
  a terminal. Failed storage never authorizes a new login.

- Show effective configuration runs the system client's configuration resolution without opening a
  remote login. It shows the effective username, address, port and whether a jump host or proxy is
  configured. Explicit username/port values override inherited configuration; blank values in alias
  mode remain inherited.

- A blank username uses OpenSSH configuration or the local account; a blank root uses the server
  login directory. Host alias mode retains existing profiles and reads `~/.ssh/config`, including
  Include files, without rewriting it.

- Blank port/username in alias mode inherit OpenSSH values. Authentication supports OpenSSH
  automatic selection, a private-key file/ssh-agent, or a password entered in the connection dialog.

- System OpenSSH must be installed; Windows users can install the OpenSSH Client optional feature.
  No SSH executable, JVM or new runtime dependency is bundled for these connection options.

### Quick connections and host search

Choose **Quick SSH connection** in the SSH sidebar and enter a Host alias, `user@host:port` or
`ssh://user@host:port`. IPv6 addresses with a port use brackets, such as `user@[::1]:2222`. A plain
alias inherits OpenSSH configuration; explicit addresses default to port 22. Commands, embedded
passwords, URL paths and invalid ports are rejected.

Quick connections use automatic OpenSSH authentication in the terminal. They appear as Temporary;
their local settings remain available for attachment after reopening the app. Closing the last
session removes a temporary connection after file channels, file tabs, transfers and tunnels have
been released. **Save connection** keeps the profile without changing existing sessions. Save it
before selecting it for a Redis or database tunnel.

**Search SSH hosts** filters the current workspace by connection name, host and username, ignoring
case. Clearing the search restores all hosts; filtering preserves sessions and connections.

### Jump hosts

In **More settings → Jump host (optional)**, choose an OpenSSH alias or enter one jump endpoint,
such as `ops@bastion:2222`. Leaving it blank inherits OpenSSH configuration. The effective
configuration preview includes the jump setting without logging in.

The same jump setting is used by terminals, SFTP, port forwarding and Redis tunnels. The jump host
uses its own OpenSSH configuration or ssh-agent; a saved target password or target-specific key is
not automatically applied to the jump host. Password mode does not support jump hosts. Multiple
jumps and ProxyCommand remain available through existing OpenSSH aliases. Older session hosts must
be safely restarted before creating sessions with an explicit jump setting.

### Local port forwarding

Open **Port forwarding** in the SSH connection header. Enter a local port, a remote address and a
remote port, then select **Add forwarding**. Rules are saved with the connection and start only when
**Start forwarding** is selected. The SSH server accesses the remote address, so `127.0.0.1` refers
to that server. Local listeners bind only to `127.0.0.1`.

Startup, listening, failure and stopped states are shown independently of terminals and SFTP. A
listening status confirms the local SSH listener, not remote service availability. **Stop
forwarding** releases the process and port; active rules cannot be removed. Hiding the panel keeps
forwarding active. Quitting stops these forwards; reopening does not restart them. Terminal
attachment continues to follow its existing lifecycle.

Opening Port forwarding hides the remote file panel while preserving its connection. Opening Remote
files hides the forwarding panel while leaving active forwards running.

- Up to 16 rules can be saved per connection, with no duplicate local ports within that connection;
  up to 16 forwards can run across the app. Ports must be 1–65535. Occupied ports and authentication
  failures remain visible; startup waits up to 60 seconds.
- Automatic/key authentication requires trusted hosts and noninteractive keys/ssh-agent. Password
  authentication follows the existing password and fingerprint policy. The connection remains
  protected from editing or removal during startup or forwarding.
- Local TCP forwarding is supported. Remote forwarding, dynamic SOCKS forwarding and automatic
  startup are not exposed. Profiles that already contain OpenSSH forwarding rules are rejected for
  this panel; use an alias without those rules to avoid opening unintended listeners.

### Connection workspace

Selecting a host returns to its last selected session in the current app run, or shows the
connection overview if it has no sessions. The overview lists the remote system, authentication and
file root. Selection does not open an SFTP connection.

The connection header shows the current session's target, resolved endpoint, terminal process status
and file connection status. New SSH terminal, Remote files and Edit SSH connection stay nearby.
Editing remains disabled while sessions, file connections, retained file tabs, transfers or
dependent workbenches use the connection.

Terminal status describes the local SSH process or attachment, not successful server authentication.
Complete fingerprint and interactive authentication prompts in the terminal. Ended sessions retain
their output; reattaching restores an existing local attachment, while a new terminal starts a new
remote login.

### Passwords and host verification

Passwords last for the current app run unless Remember password is selected. Remembered SSH
passwords are stored in macOS Keychain or Windows Credential Manager; workspace/session data
contains only an opaque reference.

Editing can keep a password by leaving its field blank, or move it between temporary memory and the
system store. Passwords bind to the connection and resolved endpoint, so target changes require
reentry.

Storage failures roll back only newly created credentials and preserve the old profile. Secrets are
not returned from the store to the frontend or placed in process arguments, environment variables,
workspace files or logs.

A short-lived authenticated loopback helper supplies the password once through OpenSSH askpass; the
helper reuses the app executable. Password mode supports ordinary password authentication, with a
native confirmation for unknown host fingerprints.

It rejects ProxyJump/ProxyCommand, verification codes and password-change prompts. Automatic/key
modes retain OpenSSH jump-host behavior; add encrypted keys to ssh-agent before using files or
tunnels.

### SSH session lifecycle

Each connection supports multiple terminal sessions, pinning, ordering and splits within that
connection. SSH runs inside the existing local PTY service with normal terminal input, resizing and
output replay.

Automatic/key modes retain terminal fingerprint and interactive authentication prompts; password
mode uses the configured password and native fingerprint confirmation. Quitting detaches while the
local SSH process continues; Close Session terminates that SSH process.

Remote process survival depends on the server. Reopening attaches to existing sessions without
silently starting new network logins.

Restart creates a new session and retains the old output. A network failure does not restore the
original remote shell; persistent server tasks require a tool such as tmux.

Older background services must be safely restarted after closing their sessions to enable SSH.

### Opening remote files

Open Remote files, then choose Connect files to start SFTP using the profile's host, port, username
and authentication. Connection progress and errors are separate from terminal status. Closing the
panel retains its cached connection; Disconnect files passes through editor save protection and
releases only file channels. Reconnect also passes through that protection and keeps the previously
resolved endpoint and root as its expected target. Neither selecting a host nor disconnecting files
starts a login automatically.

Automatic/key modes require a trusted host and noninteractive key/ssh-agent authentication; confirm
an unknown host in an SSH terminal first.

Password mode can also confirm a new host in a native dialog. File roots are independent of shell
`cd`; Windows roots must use local drive paths, not UNC shares.

Remote Git, GitHub, local directory tools, full-tree search, directory transfers, recursive deletion
and transfer resume are unavailable.

### Editing within the remote root

The file tree supports hidden files, text editing, supported image/PDF previews, creating
files/directories, renaming and deleting files or empty directories. Text retains the existing 2 MB
limit, UTF-8/BOM and line-ending handling, conflict checks, save/close guards and local recovery
drafts.

A file’s identity includes its SSH connection, resolved endpoint and canonical root, so drafts
cannot silently move to another server after configuration changes. Symbolic-link reads stay inside
the root; mutations through links are rejected.

Paths are interpreted using server rules. Remote filenames containing backslashes, colons or control
characters are excluded.

### Safe saves and conflicts

Saves use a same-directory temporary file, content version checks and the server’s
`posix-rename@openssh.com` extension; the original is never deleted as an overwrite fallback.
Servers without safe replacement allow reading, downloads and new-file uploads but open existing
files read-only.

Normal permission bits are retained when available; uTerm does not preserve Windows ACLs. Conflict
checks are optimistic and do not lock out other server writers.

Network failure after a commit can leave its result uncertain; retain the draft and reread before
retrying.

### Transfers and connection protection

Upload files from the toolbar or a directory’s context menu; download an ordinary file from its
context menu into a native save dialog. Transfers stream bounded chunks and show byte progress,
completion, errors and cancellation.

- Upload overwrite is off until explicitly selected; directory and link transfers are rejected.
  Cancellation attempts to remove temporary files, while disconnection may leave a `.uterm-*`
  temporary file for manual cleanup.

- Quitting with active transfers offers waiting or cancelling transfers before the editor save
  guard. Updates are blocked during transfers.

- At most four transfers and sixteen cached remote file connections are allowed; Reconnect releases
  that connection’s previous file channels. Editing and removal are disabled while a connection has
  sessions, retained file tabs, active transfers, starting/running port forwards or a
  connected/busy/dirty Redis workbench using it.

- Removal also requires removing dependent Redis profiles. Saving an idle SSH profile updates
  dependent Redis profiles; remembered Redis credentials remain bound to their original endpoint.

- Existing sessions retain their target.

#### SSH and SFTP checks

- Windows automated checks: 17 focused frontend tests pass, including quick-address validation,
  temporary connection cleanup/promotion, host filtering, jump/rule persistence, Redis profile
  resolution, forwarding save failures and explicit start/stop, plus the existing SSH/SFTP guards.
  All 102 regular backend tests and 26 local-service tests pass; six optional backend tests remain
  ignored. Process fixtures cover listener readiness, startup exit, timeout, cancellation and
  cleanup; they do not establish a real SSH forwarding connection.

- The full Windows frontend run passes with 241 passed and 11 skipped. Changed-file formatting,
  TypeScript, localization, documentation checks and the isolated desktop build pass.

- An isolated Windows application (`sh.uterm.desktop.qa.sshredesign`) verified the native connection
  form, default automatic authentication, Save only returning to an overview with zero sessions,
  effective OpenSSH endpoint display, a remote file panel that stays disconnected until requested,
  and independent SFTP connection progress and failure feedback. These checks used a loopback
  profile, not a successfully authenticated remote service. Real Windows SSH/SFTP authentication,
  Credential Manager and macOS/Linux acceptance of the redesigned interface remain pending.

- An isolated Windows application (`sh.uterm.desktop.qa.sshp1`) checked quick connection creation,
  the Temporary marker, saving a connection, explicit forwarding startup and separate failure
  feedback against an unavailable loopback endpoint. Reopening retained saved rules without starting
  them. At 640×420, the connection header, forwarding rules and scrollable jump-host form were
  visually inspected. Successful forwarding, a real jump server, password forwarding and the
  redesigned macOS/Linux runtime remain pending acceptance.

- Validation: macOS automated tests exercise migration, connection/session isolation, grouping,
  target validation, remote draft identity, attach-only restoration, exclusion of local tools and
  bounded progress updates. Real system SFTP-server tests cover Chinese names, safe saves,
  conflicts, root escape/link rejection, file mutations, streamed upload/download, cancelled
  overwrite and temporary-file cleanup.

- An isolated native app (`sh.uterm.desktop.qa.ssh`) connected to a loopback OpenSSH server and
  verified fingerprint confirmation, remote shell output, detach/relaunch attachment and replay,
  independent split closing, file editing, conflict retention, upload/download with matching bytes,
  file-channel reconnection, transfer progress, cancellation cleanup and the transfer exit guard.
  Additional password/connection validation: 187 frontend/build-helper tests, 32 host tests, 56
  regular backend tests and all six Redis-specific tests pass on macOS.

- Coverage includes legacy option serialization, schema 6 upgrades, invalid/secret-field rejection,
  distinct port/user/key arguments, credential target binding, failed-save cleanup, full Redis
  tunnel snapshots and authenticated one-use askpass with bounded messages, fingerprint
  approval/rejection and unexpected-prompt rejection.

- Isolated native QA (`sh.uterm.desktop.qa.sshauth`) uses real system OpenSSH with a disposable
  loopback password server to verify explicit port/username, alias inheritance/HostKeyAlias,
  password SFTP reading and Chinese-text saving, terminal output/reattachment, Redis tunnel PING and
  value reads, Keychain save/read after app restart, credential removal, temporary-password expiry
  on restart, and approving/cancelling the native host-fingerprint sheet.

- Windows client/server, Credential Manager and Linux runtime remain unverified; password-mode jump
  hosts and OTP are unsupported.

Current SSH authentication options add code without new runtime dependencies. Current release
installer sizes have not been measured; the isolated debug application build is validation evidence,
not an installer-size estimate.

## Redis connections and workbench

### Redis connection setup

Redis connections belong to a workspace. Add a name, host, port, database number and optional ACL
username/password from the sidebar.

- Test connection performs authentication and PING, then releases its temporary connection. Profiles
  are restored without connecting automatically.

- Connections support direct TCP, TLS, or a system OpenSSH tunnel selected from an existing SSH
  connection. In tunnel mode the SSH server connects to the configured Redis host; `127.0.0.1`
  refers to that server.

- Tunnels reuse the selected profile’s host, port, username and automatic/key/password
  authentication and require TCP forwarding permission. Legacy alias-only Redis profiles remain
  supported.

- The SSH selector references saved profiles, including their jump setting. Opening the Redis
  connection editor or selecting a workbench resolves the current profile; saving an idle SSH
  profile also updates dependent Redis settings. Active workbenches retain their protected target
  until disconnected. Temporary SSH connections must be saved first. Redis owns its tunnel process
  independently of terminal, SFTP and local port forwarding processes.

- Password-mode host confirmation and credential lifetime follow the SSH profile. TLS can also run
  inside a tunnel and always verifies the Redis server name; use an optional PEM CA certificate and
  server-name override.

- System trust is used when CA is blank. Mutual TLS is unavailable.

### Read-only mode and connection lifecycle

The workbench shows server version, role and PING latency when permitted; unavailable metadata does
not prevent browsing. Select DB explicitly; server restrictions remain visible.

Each connection starts read-only, including after Reconnect. Rust enforces the write switch
independently of the UI, while Redis ACLs remain authoritative.

Multiple workbenches retain their connection and in-memory editor state when hidden or when another
workspace is selected. Cmd/Ctrl+W hides the Redis view without closing a local terminal.

Explicit Disconnect closes the database connection and SSH process. Reconnect creates a fresh
connection, retains the selected DB and verifies the original endpoint before reusing the in-memory
password.

Quit releases Redis connections and tunnels; terminal sessions keep their existing detach behavior.

### Toolbar and narrow-window layout

The compact workbench keeps the connection name, endpoint, DB and read-only/editing switch in its
toolbar. Reconnect and Disconnect are always visible side by side in the connected toolbar, without
an actions menu.

- The two buttons stay together if a narrow toolbar wraps. Connection information retains its own
  menu.

- Key navigation starts at 280 pixels and supports pointer or keyboard resizing; grouping and width
  stay in memory for this run. Below 720 pixels of workbench width, Browse keys opens a drawer with
  search focus, trapped Tab navigation and Escape/backdrop dismissal.

- Selecting a key closes the drawer. Small windows scroll the detail area independently.

- Controls, menus and dialogs use the current interface theme and language.

#### Redis toolbar checks

- Connection-toolbar validation: all nine existing Redis UI regressions, formatting, localization
  and TypeScript/production build checks pass. The isolated macOS app
  (`sh.uterm.desktop.qa.redistoolbar`) uses simulated Redis replies and verifies directly visible,
  side-by-side Reconnect/Disconnect buttons at 900 and 640 pixel workbench widths, Simplified
  Chinese/English labels, and both actions.

- This checks WebView interaction rather than a live Redis connection. Windows/Linux runtime
  acceptance remains pending; production builds retain the existing large-chunk warning.

### Key search and refresh

Key search accepts the entered Redis glob pattern without adding wildcards; Enter or Search starts a
new scan. Refresh keys restarts with the current input and retains the selected detail and draft,
including when that key is absent from the current scan batch.

Group counts describe loaded keys, not database totals. The footer distinguishes
incomplete/completed scans, empty batches and the 10,000-key limit.

Empty batches remain resumable until the cursor reaches zero. There is no background scanning or TTL
polling.

### Collection browsing and drafts

Hash browsing retains its current member batch and pattern while a separate lower pane opens a
field. Changing fields, member searches/pages, reloading or closing the field editor protects
unsaved changes.

Successful field saves update a loaded row; initial Hash creation reads the server's member count
and TTL without closing the saved field. List tables show index/value, Set tables show members and
ZSet tables show member/score; range-based collections provide previous/next navigation.

String metadata reports bytes, collection metadata reports member counts, and field metadata reports
value bytes rather than Redis memory usage. TTL displays an explicit duration or No expiration, with
the millisecond snapshot available on hover.

New keys, added fields, renames and TTL changes use dialogs; delete actions identify the connection,
DB and target. Creation dialogs open an unsaved value draft; Save writes it.

Rename, TTL and deletion dialogs use a single final confirmation. Dialogs and field panes restore
focus to their entry points.

Binary keys keep their original bytes; copying a key is available only for text names. Binary and
oversized values retain their bounded read-only previews.

The Console starts collapsed and continues to accept only the registered read-only commands.

#### Redis layout checks

- Redis layout validation: nine focused UI regressions cover retained dirty drafts and collapsed
  groups during refresh, resumable empty batches, Hash batch retention and save/discard/cancel
  guards, failed mutations, single confirmations and DB targeting, binary identities, type-specific
  tables, bounded large-value paging, initial Hash metadata and drawer/resizer keyboard behavior.

- On macOS, the full frontend suite passes 208 tests with eight skipped; 73 regular backend tests
  pass with four opt-in tests ignored, and explicitly running the Redis suite passes all seven tests
  including real Redis integration. Formatting, localization, documentation, TypeScript/production
  build and isolated desktop build checks pass.

- Native QA (`sh.uterm.desktop.qa.redislayout`) connects to disposable loopback Redis and verifies
  1440×900 and 1024×768 layouts, the 640×420 drawer and scrollable editor, Simplified Chinese/dark
  and English/light interfaces, Hash editing/formatting and save guards. Windows/Linux runtime
  acceptance of this layout remains pending.

### Scan and value limits

Keys use cursor-based SCAN with a COUNT hint of 200, optional glob patterns, deduplication and colon
grouping. Empty scan pages return without a metadata request or timeout and do not imply completion;
continue until cursor zero.

- At most 10,000 keys are retained per workbench; narrow the pattern at the limit. String values
  support 1 MB byte-range previews and editing when the complete value is valid UTF-8 and no larger
  than 1 MB.

- Hash fields support incremental browsing and individual editing. Lists and sorted sets use
  200-member ranges; sets and hashes use cursor scanning with member patterns.

- Collection cells show at most 64 KB; unusually large scan batches are marked partial and require a
  narrower pattern. Keys/field names are limited to 4096 bytes.

- Binary keys retain their original byte identity, and invalid UTF-8 values show a hexadecimal
  preview. A 16 MB protocol-read budget closes oversized responses rather than retaining an
  unbounded reply.

### Binary and Java serialization previews

Binary String values and individual binary Hash fields show serialization information below the
first 256 hexadecimal bytes. Java Object Serialization previews identify the stream version and,
when readable, the first ordinary class descriptor, serialVersionUID and field names/types; expand
Fields to inspect them.

- Readable UTF-8 text preserves visible strings, replaces control characters with · and invalid
  bytes with �, and is limited to the current page’s first 64 KB. Metadata inspection is limited to
  256 fields and 4096 bytes per name/type string.

- Truncated or unsupported descriptors retain recognized information with a partial-information
  message; later String pages do not infer a stream header. The view remains read-only and does not
  reconstruct full objects, inherited/nested descriptors or custom codecs.

- No JVM or additional runtime dependency is required.

### Editing and write protection

Enable editing to create String, Hash, List, Set or ZSet data, edit a String or individual Hash
field, delete a Hash field, rename without overwriting another key, delete a key, or set/clear TTL.
Saves serialize WATCH/read/compare/MULTI/EXEC on the connection and reject stale or missing
originals.

For List, Set and ZSet, choose **New key**, enter a name and select the type, then choose **Create**
to open the initial member draft. Enter the value and choose **Save** to create the key. An empty
value is a valid member; creating an empty collection without a member is unavailable. An existing
key is never overwritten.

- Use **Add member**, **Edit member** and **Delete member** above or inside the member table. List
  additions go to the start or end, and edits/deletions target the displayed zero-based index,
  including when values are duplicated. Set edits replace a member. ZSet edits change the member,
  its score, or both; scores accept finite, representable decimal numbers and scientific notation.
  Nonzero inputs that underflow to zero are rejected. Adding or replacing a Set/ZSet member refuses
  an existing destination member.

- Adding and editing open a draft; only **Save** writes. Score-only changes also count as unsaved.
  Changing members, paging, closing the editor, switching targets, disconnecting or exiting uses the
  save/discard/cancel guard. Failed saves retain the value and score. Deleting a member uses one
  confirmation showing the connection, DB, key and member/index; deleting the last member also
  deletes the key.

- List index edits compare a complete snapshot, limited to 10,000 members and 1 MB of combined value
  bytes. Larger lists remain browsable and accept start/end additions. Set edits check the original
  member; ZSet edits also compare its original score. Existing collection TTLs survive additions,
  edits and deletion of a member when the key remains.

- Complete UTF-8 members shown in the 64 KB table previews can be edited; binary or truncated
  previews cannot be edited. Complete binary members can be deleted. Each new member value is
  limited to 1 MB. Successful writes reread the collection and refresh keys; Set filters and ZSet
  ordering can place the changed member outside the displayed batch.

- Existing String saves preserve their current TTL and require server support for KEEPTTL. Save
  failures retain the draft.

- Write timeouts close the connection and report an uncertain result; reread before trying another
  write. No write is replayed automatically.

- Key deletion and key/TTL mutations require confirmation. The console accepts only PING, restricted
  INFO sections, DBSIZE, TYPE, TTL/PTTL, EXISTS and length commands; it does not execute arbitrary
  commands.

- Cluster/Sentinel discovery, subscriptions, Monitor, scripts, bulk import/export and dedicated
  Stream/module views are unavailable.

#### Redis collection editing checks on Windows

- Four focused backend checks pass, including input/score limits and three checks against disposable
  loopback Redis 5.0.14 servers. They cover creation, read-only and DB protection, collisions,
  empty/Unicode members, duplicate list positions, stale snapshots, concurrent edits, TTL
  preservation, score changes, rejection of underflowing scores without changing the original
  member, and removal of the last member.

- On Windows, the full frontend suite passes 246 checks with 11 optional/platform checks skipped.
  All 17 Redis UI/logic checks pass; the two final regressions also pass after the last adjustment,
  covering guarded previous-page navigation and returning to a valid page after deleting a member.
  The regular backend suite passes 105 checks with nine optional checks ignored. Locked dependency
  installation, localization, TypeScript/production build, desktop build, changed-source formatting
  and documentation checks pass. The production build retains its existing large-chunk warning.

- An isolated native Tauri/WebView2 app (`sh.uterm.desktop.qa.redismembers`) renders the real
  workbench and CodeMirror editor with simulated responses. It verifies all five creation options,
  List/Set/ZSet creation and member operations, list insertion position, score-only drafts, retained
  conflict drafts and one deletion confirmation. English/dark and Chinese/light inspection covers
  the wide layout and a 640×420 viewport, including visible Save and save/discard/cancel protection.

- The native UI fixture does not connect to a database; real-service coverage comes from the
  separate disposable Redis checks. macOS/Linux runtime acceptance and authenticated TLS/SSH service
  acceptance remain unverified for these member operations. Existing app and database processes were
  not restarted.

### Credentials and unsaved changes

Passwords are temporary by default. Remember password stores a target-bound entry in macOS Keychain
or Windows Credential Manager; workspace storage contains only its opaque reference.

Changing the endpoint, username, TLS trust or resolved SSH target requires entering and saving the
password again. Passwords are not returned to the frontend from the credential store, added to
command arguments, or written to logs.

Redis values and editor drafts are not written to local storage. Save/discard/cancel guards protect
changing the edited value or DB, disconnecting and reconnecting; quitting also reveals a hidden
dirty workbench.

Active handshakes/writes delay quitting, and unsaved edits or active operations block update
installation. At most eight Redis connections are open at once.

Connected, busy or dirty profiles cannot be edited or removed.

#### Redis connection and write checks

- Validation: all six Redis-specific backend tests pass on macOS, including four opt-in real Redis
  tests executed by `pnpm test:redis`. They cover authentication, binary values, DB isolation, SCAN,
  collections, permissions, TTL retention, conflicting concurrent saves, name collisions,
  large-value limits, trusted/untrusted TLS and incorrect certificate names.

- A deterministic lost-EXEC-reply test verifies an uncertain write is never replayed. Frontend tests
  cover schema upgrades, secret rejection, byte identities, quoting, read-only defaults, retained
  hidden drafts, conflicts, reconnection, late connection cleanup and avoiding local-session
  closure.

- Isolated native QA (`sh.uterm.desktop.qa.redis`) with loopback Redis 8.8 and OpenSSH verifies
  direct/TLS/SSH connections, Keychain save/read, Chinese String editing, Hash-field editing,
  conflict retention, draft discard/reload, the exit guard and tunnel cleanup. Windows
  runtime/Credential Manager, Linux server runtime, Redis 6/7, external cloud services and
  credentialed ProxyJump remain unverified.

#### Binary-preview checks

- Binary preview validation: regression tests use a real ObjectOutputStream fixture and cover shared
  type references, modified UTF-8 metadata, signed serialVersionUID, every truncated prefix,
  malformed references/lengths, field/text limits, later-page detection and literal markup display
  without writes. An isolated macOS app (`sh.uterm.desktop.qa.redisbinary`) with loopback Redis
  verifies Java String and Hash-field previews, ordinary binary text and the 64 KB truncation
  message.

- Windows/Linux runtime acceptance of this preview remains pending.

#### Package measurements and scope

- Package measurement with the same macOS ARM64 QA identifier and build parameters: DMG size rises
  from 10,440,236 bytes (10.44 MB) to 10,866,289 bytes (10.87 MB), approximately +0.43 MB; the app
  bundle rises from 29,025,292 bytes (29.03 MB) to 30,484,572 bytes (30.48 MB), approximately +1.46
  MB. Both builds use the README's `CARGO_PROFILE_RELEASE_STRIP=none` workaround.

- No Redis/SSH executables, frontend runtime dependencies or second TLS cryptography backend are
  bundled by this feature. Final native checks additionally verify saved credentials after relaunch,
  read-only reset on reconnect, TLS-over-SSH connection testing and dialog button layout.

- Windows/x64 and signed installer sizes are unmeasured.

## Files and source control

### Rolling back one file

In Git → Changes, right-click a file in Staged or Working directory (or focus it and press
Shift+F10), choose Roll back file, review the path and confirm. This restores both the file's staged
and working changes to HEAD.

- Added files, including untracked files and staged files before the first commit, are deleted;
  staged renames restore the original path and remove the new path. The prompt states that rollback
  cannot be undone and initially focuses Cancel.

- Compare and History do not offer rollback. Links, submodules, directories and paths outside the
  selected directory are rejected; a renamed file's original path with other changes must be
  resolved in a terminal.

- Other files are retained.

Rollback runs off the UI thread and is serialized with branch operations. The editor saves and
closes the directory's cached files first; save conflicts retain the draft and block rollback
through the existing Retry/Discard/Cancel flow.

Changing repositories while a save is pending cancels the deferred rollback. A changed file status
or HEAD rejects the request.

Completion refreshes the file, Git and GitHub panels; failures remain visible through background
refreshes.

#### Validation and limits

- Windows validation: 163 frontend/build-helper tests pass with two platform-specific skips, and all
  48 backend tests pass. Focused regression coverage includes bilingual confirmation/cancellation,
  menu dismissal and focus restoration, save conflicts, duplicate requests, delayed actions,
  persistent errors, staged/working content, deletion, additions, renames, literal Unicode paths,
  root boundaries, links, submodules and stale requests.

- Locked dependency installation, TypeScript/production build, localization, documentation,
  changed-file formatting, both Cargo formatting checks and the isolated desktop build pass. Native
  QA (`sh.uterm.desktop.qa.gitrollback`) verifies the right-click menu, the added-file warning and
  cancellation preserving its content.

- Native staged/rename rollback, editor-conflict interaction and macOS/Linux runtime acceptance
  remain unverified. The production build retains its large-chunk warning.

### Local and remote branches

The toolbar branch picker groups local branches under Local and server branches under Remote
(`remote/branch`). Opening the list queries every configured remote for all advertised branch heads,
including branches not fetched locally and branches outside a single-branch clone's fetch
configuration; tags and symbolic remote HEAD entries are excluded.

- Local branches refresh periodically and on window focus. Remote reads show a loading state and
  per-remote failures without hiding successful results.

- Network access and existing Git credentials are required; authentication or timeout failures
  remain visible and reopening retries the query. Non-Git directories have no picker.

- Detached HEAD and repositories without a first commit can select an available branch.

### Switching branches

Selecting a remote branch fetches it and creates a same-named local tracking branch, extending a
narrow fetch configuration when needed. An existing local branch is reused only if it tracks that
exact remote branch; conflicting names are rejected without resetting the branch.

Selecting an existing local branch uses Git's normal switch checks. The editor saves and closes
before switching or syncing; save conflicts retain the draft and block the operation until resolved
or explicitly discarded.

Git rejects switches that would overwrite file changes or use a branch occupied by another Worktree.
No force, automatic stash or file discard is used.

### Push, Pull, Fetch and Refresh

Right-click anywhere on the branch control (or press Shift+F10) for Push, Pull (fast-forward only),
Fetch and Refresh branches. Push explicitly targets the current branch's configured upstream without
force or automatic tag pushing.

- Pull fetches the upstream and fast-forwards without requiring a clean working tree. Unrelated
  staged, unstaged and untracked files are retained; Git rejects updates that would overwrite local
  changes. No automatic stash, merge commit or rebase is used, and divergent history is rejected.

- Push/Pull are disabled for detached/unborn branches or missing upstreams; configure the upstream
  in a terminal first.

- Fetch updates all branch references from each configured remote and prunes deleted remote
  references without switching or merging. Refresh branches re-reads the Local/Remote lists.

- Git actions run off the UI thread and are serialized. The control keeps the current branch name
  during Push, Pull, Fetch and branch switching, and stays disabled until the operation finishes.
  Screen readers receive progress announcements; the context menu reports completion. Failures are
  displayed, and file/Git/GitHub panels refresh after operations, including partial failures.

- Menu navigation supports arrows, Home/End, Enter, Escape and outside-click dismissal; application
  shortcuts are suppressed while the menu is open. Switching blocks duplicate requests and editor
  transitions, and stale responses cannot replace newer branch state.

#### Branch-label checks on Windows

- The focused branch-selector regression passes, including retained branch names during switching
  and delayed Pull in Simplified Chinese/English, busy-state protection, completion, editor-save
  conflicts, stale responses and visible Git errors. Windows validation passes frozen dependency
  installation, repository formatting, localization, documentation, TypeScript/production and
  isolated desktop builds, 278 frontend tests (11 skipped), 110 backend tests (nine ignored) and 38
  host tests (two ignored). The production build retains its existing large-chunk warning.

- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.branchlabel`) renders the real
  selector with simulated Git replies. Native inspection verifies that a pending Pull retains
  `release` in Chinese/dark and English/light appearances, keeps the selector disabled, preserves
  screen-reader status text and enables the control on completion. This does not validate live
  remote operations or credentials; macOS/Linux runtime acceptance remains pending.

### Git commit history

Open Git → History and hover over a commit to see its full message, complete hash, author and
timestamp. Clicking the commit opens its details in the inspector: the message retains paragraphs
and line breaks, followed by the changed-file count and file list. Long messages scroll within the
details area, and text remains selectable.

- Click a changed file to inspect its diff. Existing unified/side-by-side views, file navigation and
  expansion remain available. Empty commits show an explicit message instead of an empty list.
- Back to history returns to the loaded commit list. Switching repositories leaves the old commit
  details, and late file-list responses cannot replace a newer selection. Read failures remain
  visible; returning to the list and opening the commit again retries the read.
- History loads 100 commits per page and supports Load earlier commits. A page of commit messages
  exceeding the 2 MB output limit shows an error and directs the user to `git log` in a terminal.
  Messages are displayed as plain text.

#### Commit-history checks on Windows

- Eleven focused Git/history/diff/refresh and content-font tests pass. Coverage includes full
  multiline and bilingual messages, plain-text rendering, metadata, file counts, diff references,
  empty commits, failed reads/retry, stale responses and repository switching. Backend checks report
  108 passed and nine ignored tests; Git regressions use temporary local repositories and cover
  message preservation, pagination, root commits and the output-size limit.
- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.gitdetails`) runs the real Git panel
  and Git read commands against a temporary repository. Checks cover tooltip contents, native
  commit/file clicks, keyboard activation, empty/root commits, real diffs and expanded diffs with
  commit details retained. Visual inspection covers Chinese/dark and English/light views and
  wrapping in a 280 px panel.
- Production and desktop builds, TypeScript, localization, documentation, changed-file formatting
  and Cargo formatting pass. Production builds retain the large-chunk warning. macOS/Linux runtime
  acceptance remains pending.

### Git comparison tabs

Expanded comparisons also appear as a closable Git/file-name tab in the central tab bar. Selecting a
terminal or file hides the comparison while retaining its tab; selecting the comparison tab restores
it.

Closing its tab returns the comparison to the inspector. Main toolbar and Git tools remain
available.

#### Validation and limits

- All 156 frontend/build-helper tests, localization checks, frontend build and isolated macOS
  desktop build pass. Component regression checks cover selection and retained diff content.

- The isolated QA app launched, but the native automation connection closed before comparison-tab
  inspection; native acceptance of the new tab and Windows runtime validation remain pending.

### Expanded Git diffs

Git file comparisons offer Expand diff to show the selected diff in the central content area while
retaining the main toolbar, workspace tabs, inspector toolbar and Git file list. The diff toolbar
moves with the diff and retains Copy Diff, unified/side-by-side comparison, previous/next file,
inspector-only display and Close diff.

Inspector-only display returns the diff to the inspector; closing the diff restores the previous
central terminal/editor without terminating sessions or discarding file buffers. The inspector
remains resizable in central display mode.

#### Validation and limits

- Component regression tests verify the portal placement, retained main toolbar and inspector file
  list, and returning to inspector display. All 152 frontend/build-helper tests, formatting,
  localization, documentation checks and frontend/isolated desktop builds pass on macOS.

- The isolated native QA app (`sh.uterm.desktop.qa.gitcenter`) verifies central diff display with
  both toolbars and the Git file list visible, and returning to inspector-only display. Windows
  runtime acceptance remains pending.

### File tab limit

Settings → General → File tab limit sets the maximum number of open file tabs per directory (default
10, minimum 1, whole numbers only). The preference persists across restarts.

- Opening a file beyond the limit closes the earliest opened file tab; switching to an existing tab
  does not change its opening order. Lowering the limit also removes the oldest excess files.

- Terminal and Agent sessions are excluded and remain running. Saves and conflict protection run
  before automatic removal; failed saves retain drafts and require resolution.

#### Validation and limits

- All 157 frontend/build-helper tests, localization checks and frontend/isolated macOS desktop
  builds pass. Tests cover old-settings defaults, invalid values, FIFO eviction, existing-tab
  selection, reducing to one, conflict protection and retaining the session tab.

- Native QA (`sh.uterm.desktop.qa.tablimit`) verifies the General layout, default 10 and saving 1.
  Native automatic eviction and Windows runtime acceptance remain pending.

### Switching file tabs

File-tab selection directly uses the guarded open operation, avoiding a nested hide/open transition
that would block opening the target.

#### Validation and limits

- App regression checks verify switching between retained files, saving edits and returning from a
  terminal to a file. All 156 frontend/build-helper tests and frontend/isolated macOS desktop builds
  pass.

- Native QA (`sh.uterm.desktop.qa.tabswitch`) verifies switching between two file tabs and returning
  from a file to the terminal; the QA app exited before the final terminal-to-file native check.
  Windows runtime acceptance remains pending.

### Middle-click to close file and diff tabs

Middle-clicking a file or Git diff tab closes it through its existing close action. File
save/conflict guards still apply; closing a background file retains the visible tab.

Middle clicks never close terminal or Agent sessions, and disabled transitions ignore closing.

#### Validation and limits

- Component tests cover file closing, conflict protection, disabled guards, ignored right clicks,
  retained terminals and Git diff closing. All 159 frontend/build-helper tests and frontend/isolated
  macOS desktop builds pass.

- Native QA (`sh.uterm.desktop.qa.middletab`) verifies current/background file closing and keeping a
  terminal session. Native Git diff middle-click and Windows runtime acceptance remain pending.

### Central tab bar

The main workspace has a horizontally scrollable tab bar showing only the currently selected
terminal or Agent session, plus files opened in the current directory. The tab bar is hidden when
there are no file or Git diff tabs, even if terminal or Agent sessions are running.

- Opening a file or diff shows it again. Component checks cover session-only hiding and hiding after
  the last file closes; native layout acceptance remains pending.

- Other running sessions remain in the sidebar and take no space in the central tab bar. Selecting a
  different sidebar session replaces the session tab, including while a file is visible; the session
  tab remains available to return from a file to that session.

- Opening another file adds a tab; reopening the same directory/path selects its existing tab. File
  tabs show an unsaved marker and a close button on the right.

- Closing a background file leaves the active view unchanged; closing the active file returns to the
  selected terminal or welcome page. Terminal and Agent tabs, and terminal pane headers, have no
  close button; the sidebar retains Close Session.

- Selecting a session from the tab bar or sidebar retains open file tabs and running terminal
  output. Switching or closing the active file saves changes first; save/conflict failures block the
  action and preserve the recovery draft until Retry, Discard or Cancel.

- Git operations and file-tree mutations retain their save guard and close cached files in the
  affected root to avoid stale content. File tabs remain in memory for this run and are scoped by
  directory; they are not restored after restart.

- File text is retained between switches, while editor view history and cursor position are
  recreated. Keyboard arrows/Home/End navigate the tab bar, long names are truncated with full paths
  in tooltips, and language switching updates tab labels.

#### Validation and limits

- All 152 frontend/build-helper tests, formatting, localization, documentation checks and
  frontend/isolated desktop builds pass on macOS. An isolated QA app (`sh.uterm.desktop.qa.tabs`)
  verifies two-file switching, saved edit retention, terminal output retention, active/background
  file closing, sidebar-only session close controls in the visible workspace, and long-label
  truncation with a fully visible close button in a 720×520 window.

- The isolated macOS QA app (`sh.uterm.desktop.qa.focusedtab`) verifies that two running terminals
  produce only one central session tab, sidebar selection replaces that tab, and an open file tab is
  retained. Native Agent, conflict-dialog and Windows runtime acceptance remain pending.

### File-tab context menu

Right-click an open file tab, or focus it and press Shift+F10, to open its file menu:

- **Copy** places the file in the application's file clipboard; use Paste in the file tree to copy
  it into a folder, including a different project.
- **Copy file name** copies the final name to the system clipboard.
- **Copy file path** copies the full path. Windows drive and UNC paths omit the extended-path
  prefix.
- **Open in File Manager** reveals the local file in its containing folder.

The menu acts on the clicked tab without switching the active file or saving its draft. Copy uses
the file on disk; save edits first to include them in the copy. Remote tabs allow copying their name
or SSH path; file copying and opening a local file manager are disabled.

The menu stays within the window and outside the tab bar's scroll clipping. Arrow keys and Home/End
navigate actions; Esc closes it and returns focus to the tab. Clicking outside, scrolling the tab
bar, resizing or leaving the window closes it. Copy and opening failures appear visibly.

#### File-tab menu checks on Windows

- Three focused component checks pass, including existing tab/draft guards and file-tree menus. The
  new regression covers background-tab targeting, cross-project paste, normalized Windows clipboard
  paths, remote restrictions, keyboard focus, edge positioning and visible failures. TypeScript,
  localization, changed-source formatting and production build pass.
- An isolated Windows app (`sh.uterm.desktop.qa.tabmenu`) uses the real tab bar, file panel and
  filesystem commands with disposable files. Chinese/dark and English/light views verify all four
  actions, system clipboard writes, real file copy/paste, file-manager command success, retained
  active tab, keyboard controls and an unclipped menu at 640×420.
- Explorer's selected-file highlight and macOS/Linux runtime behavior for this tab menu remain
  unverified. The production build retains its existing large-chunk warning.

### Automatic file-tree refresh

The visible file tree automatically refreshes its root and expanded folders five seconds after each
directory read completes. Manual Refresh files remains available.

Refresh retains expanded folders, scroll position and inline name inputs; it does not reload editor
contents. Slow reads do not overlap within a folder’s refresh cycle, and collapsing a folder,
changing projects or closing the panel cancels its timer and ignores late results.

Quick-open and content-search results are not periodically queried.

#### Validation and limits

- Component tests cover updated listings, scheduling after completion and timer cleanup; frontend
  tests, TypeScript/production build, formatting, localization and documentation checks pass on
  macOS. Native timing and Windows runtime acceptance remain pending.

### File-operation errors

File-list operation errors (creation, renaming, deletion, copying, pasting and opening in the file
manager) disappear after three seconds. Each failed action restarts the timer, including identical
errors; typed names remain intact.

Directory-loading and search errors remain visible.

#### Validation and limits

- Component timer tests cover dismissal and repeated failures; native timing acceptance remains
  pending.

### Quick-open file menu

Under Files → Quick open, right-click a result or press Shift+F10 on the focused result to open its
menu. Arrow keys move between actions; Escape closes the menu and returns focus to that result.

- **Copy** keeps the selected local file in uTerm's internal clipboard. Switch to the file tree and
  choose Paste on the destination folder; the existing copy rules and conflict checks apply.

- **Copy file name** copies the final name to the system text clipboard.

- **Copy file path** copies the absolute path, omitting Windows extended-length prefixes.

- **Open in File Manager** reveals the local file in its containing folder; it is disabled for SSH
  files. Clipboard and opening failures remain visible.

The menu targets the result that opened it without opening the file. It is available in Quick open;
content-search results keep their existing behavior.

#### Validation and limits

- Windows component regression covers the four actions in both languages, the selected target,
  normalized paths, internal Copy/Paste, keyboard dismissal and visible failures.

- The isolated Windows app (`sh.uterm.desktop.qa.contentcontrols`) uses the real App, a temporary
  project and filesystem commands. Quick-open Copy followed by file-tree Paste writes the expected
  file in that root. Chinese/dark and English/light menus were visually inspected, including a 1000
  × 700 viewport. Clipboard and file-manager calls use fixtures; this check does not launch
  Explorer. macOS/Linux runtime acceptance remains pending.

### Copying files and folders

The file tree supports Copy/Paste from its context menu and Ctrl+C/Ctrl+V (Cmd+C/Cmd+V on macOS)
while the list is focused. A folder receives the copy; a file targets its parent, and blank space
targets the project root.

- This single-entry internal clipboard retains the source project across project changes and panel
  remounts, allowing pasting into another project. It resets when the application reloads and does
  not import files from the system clipboard.

- Source and destination are separately validated within their project roots; missing sources report
  an error. Component and Windows backend tests cover cross-project copying, conflicts, missing
  sources and traversal.

- Files, binary content and complete directories are supported without overwriting existing names.
  Links, special files, root copies and self/descendant destinations are rejected.

- Copy runs off the UI thread, stages content locally and limits recursion to 64 levels and 100,000
  entries; extra disk space is required. A final write failure may leave an incomplete destination,
  reported visibly for inspection.

#### Validation and limits

- Component and backend tests cover destination routing, recursive copying, conflicts and traversal;
  a mocked browser preview verifies the menu and refreshed tree. Native WebView and macOS acceptance
  remain pending.

### Static HTML preview

HTML and HTM files open in static preview, with an Edit/Preview toggle that previews unsaved text
without saving. Full-document head styles, inline CSS and embedded data images are preserved.

The isolated frame blocks scripts, external/local linked resources, forms and navigation; pages
needing JavaScript (including Vite/React entry HTML) must use their development server. Such
dependencies display a limitation notice rather than an unexplained blank panel.

#### Validation and limits

- Regression tests cover style preservation and active-content removal. Native WebView acceptance
  remains pending.

### Open in File Manager

Project, Worktree and local file-tree context menus offer Open in File Manager. The file-tree menu
expands to show its actions, including this entry after Copy path, and uses its measured size to
stay inside the window.

It scrolls only when the available window height cannot fit all actions; arrow keys still reach the
lower entries. The action is disabled for SSH remote files.

The Worktree action opens that Worktree's own directory and is disabled for a missing Worktree.
Folders open directly; files are revealed in their containing folder.

File-tree paths are checked against the selected root before opening. Opening failures remain
visible.

#### Validation and limits

- An isolated macOS QA app (`sh.uterm.desktop.qa.worktreeopen`) verified the Worktree menu layout,
  dismissal after activation and Finder opening the Worktree directory.

#### File-menu checks on Windows

- File-menu validation on Windows: 19 related frontend checks, changed-source/test formatting,
  localization/documentation checks and TypeScript/production build pass. The focused regression
  covers measured edge positioning, language-dependent height changes, short viewports, keyboard
  access, file/folder/root targets, menu dismissal and visible opening failures.

- An isolated native host (`sh.uterm.desktop.qa.filemenu`) uses the real FilePanel and
  filesystem/opener commands with a temporary root. Chinese/dark and English/light menus show all
  local actions without scrolling, including at the window's bottom-right edge; file and root
  actions open Explorer at the correct directory.

- Explorer file selection, Windows project/Worktree actions and macOS/Linux file-menu layout remain
  unverified. The production build retains its large-chunk warning.

### Name conflicts

Creation and renaming report conflicts separately for files and folders, including cross-type
collisions. Renaming to the unchanged name succeeds without writing.

Editing the input clears the previous validation message. Files and folders still cannot share a
name in the same parent directory.

#### Validation and limits

- Backend regression tests cover these rules; native interaction acceptance remains pending.

### Windows path display

The session header, file-viewer header, file-panel footer and their tooltips display Windows paths
without the extended-length prefix (`\\?\` or `//?/`). Local paths start at the drive letter, such
as `D:\project\AGENTS.md`; UNC paths retain `\\server\share\…`. Internal filesystem paths remain
unchanged.

#### Validation and limits

- Nine focused file-document and viewer-header checks pass on Windows. The header regression covers
  both prefix spellings, mixed separators, Unicode, drive roots, UNC shares and unchanged POSIX
  paths; it also checks that display formatting preserves the document's file identity.

- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.filepath`) uses the real FileEditor,
  sample Markdown documents and mocked desktop commands. Six path cases pass for the visible header
  and tooltip, with screenshots inspected for drive and UNC paths. TypeScript, the fixture's
  frontend and native builds, changed-test formatting and documentation checks pass. The real App
  fixture (`sh.uterm.desktop.qa.contentcontrols`) also verifies drive-letter paths in session/file
  headers and the file-panel footer. A focused path regression covers drive, UNC and POSIX display
  while desktop commands retain the original directory. macOS/Linux runtime acceptance remains
  pending.

### Inline creation and renaming

New files and folders are named inline inside the target folder in the file tree; renaming edits the
existing row. Enter confirms and Escape cancels; failures retain the input.

Creation from a folder's context menu expands that folder. Refresh preserves expanded folders.

Deletion still requires explicit confirmation. Native inline-edit focus and input-method acceptance
remain unverified.

### Root boundaries and recovery drafts

File access stays within the selected project root. Text saves check for conflicts and retain
unsaved drafts for recovery.

Markdown is sanitized before rendering; PDF canvas dimensions are bounded. Git views include status,
diffs and commits, with worktree management.

GitHub integration requires the user's credentials and access.

### View on GitLab

The Working directory panel places View on GitLab directly below View on GitHub. It opens a
repository whose remote hostname contains `gitlab` (case-insensitive), including self-hosted
instances and nested groups, preferring a matching `origin`.

HTTP/HTTPS remotes retain their web port; SSH remotes open the corresponding HTTPS site on its
default port. Custom web ports must be provided through an HTTP/HTTPS remote.

Embedded credentials are omitted from the browser link. Missing remotes and opening failures remain
visible.

#### Validation and limits

- Component tests cover button order, invocation, busy state and bilingual errors; backend tests
  cover remote conversion and selection. All 218 frontend/build-helper tests and 76 backend tests
  pass, with eight frontend tests skipped and four backend tests ignored.

- Formatting, localization, TypeScript/production build, documentation checks and an isolated macOS
  app build pass. The isolated app (`sh.uterm.desktop.qa.gitlab`) verifies the button order, icon
  and visible error when the directory is not a Git repository.

- Authenticated GitLab access and Windows runtime acceptance remain unverified.

## Agents and settings

### Enabling Agents

Settings → Agent and the standalone Agent panel place an Enable switch after each program’s
availability status. Agents start disabled until explicitly enabled; the choice is saved across
restarts.

- Only enabled, detected Agents appear in project/Worktree creation buttons, the Add menu and the
  default chat Agent selector. Missing programs cannot be enabled; a previously enabled program that
  becomes unavailable can still be disabled.

- New chat uses the preferred Agent when enabled and available, otherwise the first enabled,
  available Agent; without one, the action is disabled. Turning an Agent off hides its creation
  entries without closing existing sessions or removing its program, configuration or Hooks.

- Saving failures remain visible and preserve the previous selection.

### Finding and configuring Agents

Settings → Agent and the standalone Agent panel provide a compact list with enable switches. Search
by name, ID or program command, or filter to available or enabled Agents. Select an Agent to see its
availability, program and applicable installation, configuration and Hooks actions in the detail
area. Use Add agent to configure a custom program.

Wide panels place the list and details side by side with separate scrolling. Narrow panels stack
them vertically. Search and filters affect this view only; they do not change which Agents are
enabled or close existing sessions.

#### Layout checks and limits

- Nineteen focused interface checks pass, including search, empty results, filter and switch
  interaction, custom Agents, installation confirmation/errors and Hooks targets in both languages.
  The complete frontend/build-helper suite passes 284 tests with ten optional/platform checks
  skipped. Formatting, localization, TypeScript/production build and an isolated macOS desktop build
  pass.

- Native macOS QA (`sh.uterm.desktop.qa.agentlayout`) uses the real Agent settings with mock
  availability and temporary preferences. Visual inspection covers wide and narrow containers,
  Chinese/dark and English/light views, search and the configuration form. Native dropdown
  selection, a complete keyboard-only flow, actual installation/Hook changes and Windows/Linux
  runtime acceptance remain unverified. The installed application was not replaced or restarted.

### Usage and quota refresh

Settings → Usage provides separate Claude, Codex, Kimi and Grok tabs. Opening Usage immediately
queries Claude, and selecting another Agent tab directly queries that Agent, including its local
seven-day token totals and available provider quota windows.

- Each tab retains its latest result and error while switching between Agents; macOS automatically
  allows the Claude query to request credentials from Keychain. The Usage page also sets the
  remaining-usage refresh interval to a whole 10–3600 seconds (60 seconds by default); the value is
  saved across restarts.

- For an active supported Agent session, the workspace title bar queries immediately and then at
  that interval, without overlapping a still-running request. Clicking the remaining percentage
  opens every valid quota window with its remaining percentage, progress and reset time; clicking
  outside or pressing Escape closes the details.

- A failed or credential-less quota query hides the title-bar indicator until a later refresh
  succeeds.

#### Validation and limits

- The 147 frontend/build-helper tests, localization check and production build pass, including
  settings compatibility, interval validation, automatic tab queries, non-overlapping refresh and
  the clickable details; authenticated provider queries and native interaction remain pending.

### Token logs and incomplete UTF-8 records

Local token logs are read as bounded byte records. When reading a large file tail, the incomplete
first record is discarded before UTF-8 decoding.

Records containing invalid UTF-8, including unfinished characters in logs being written, are skipped
and the totals show a partial-record notice; valid records and provider quota requests can still be
processed. Real filesystem read errors remain visible.

The seven-day filter, 8 MiB per-file limit, 64 MiB total budget, five-second scan limit and
deduplication rules remain in effect.

#### UTF-8 usage checks on Windows

- UTF-8 usage validation on Windows: all 84 backend checks pass (six optional/resource checks
  ignored), together with 18 focused usage and bilingual interface checks. Regression fixtures cover
  a fully valid UTF-8 file whose 8 MiB tail starts inside a Chinese character, invalid bytes between
  valid records and incomplete final characters for Claude, Codex, Kimi and Grok.

- Interface checks retain token totals and quota windows alongside the partial-record notice in both
  languages. Changed-source formatting, localization, documentation, TypeScript/production and the
  isolated Windows desktop build (`sh.uterm.desktop.qa.usageutf8`) pass.

- The production build retains its large-chunk warning. Authenticated provider queries and
  macOS/Linux runtime acceptance of these paths remain unverified.

#### Agent-enablement checks

- Agent enablement validation: all 145 frontend/build-helper tests, 39 backend tests, local-session
  service tests, locked dependency installation, formatting, localization, documentation checks,
  TypeScript/production build and the isolated macOS desktop build pass. Settings and component
  tests cover explicit defaults, invalid saved values, built-in/custom Agents, immediate entry
  updates, default-chat fallback, existing-session retention, persistence, bilingual labels and
  storage failures.

- The isolated macOS QA app (`sh.uterm.desktop.qa.agentenable`) verifies switch alignment after
  availability, the unavailable-program disabled state, shared settings/Agent-panel state, and Codex
  disappearing from and returning to the Add menu when toggled. Native restart persistence, keyboard
  interaction and Windows runtime acceptance remain pending.

### Kimi executable discovery

Kimi detection and Agent launch search `~/.kimi-code/bin` after inherited PATH entries, alongside
the existing default installation directories. This lets macOS apps launched with a minimal GUI PATH
find Kimi without depending on a terminal startup environment.

Explicit program paths and PATH precedence are preserved. Custom installation locations still need a
configured absolute executable path.

#### Validation and limits

- An isolated subprocess regression test with an empty PATH verifies detection and the launch PATH;
  another verifies PATH precedence. Local-service tests, 39 backend tests and the desktop/production
  build pass on macOS.

- The installed application has not been replaced, and authenticated Kimi sessions and Windows
  runtime behavior remain unverified.

### Agent brand icons

Kimi, OpenCode, Grok, Hermes, Pi, MiniMax, Qwen Code, Copilot CLI, iFlow CLI and TRAE CLI use their
brand icons in Agent settings, sidebar creation/session controls and session tabs. Hermes, MiniMax,
Qwen Code, Copilot CLI and TRAE CLI use Lobe Icons' original brand paths; Pi uses its official SVG
geometry, and iFlow uses the official CLI site's favicon. Sources and applicable rights are retained
in `NOTICE`.

Vector marks inherit the interface color in dark and light themes; iFlow retains its original image
colors. All assets ship locally and need no network request. Unknown agents retain the terminal
icon.

#### Brand-icon checks on Windows

- Windows validation passes 17 focused frontend checks, changed-source/test formatting and
  TypeScript/production build. Icon checks cover the bundled paths, original iFlow image, distinct
  marks and safe fallback for unknown identifiers.

- The isolated native Tauri/WebView2 fixture (`sh.uterm.desktop.qa.agenthooksicons`) renders the
  real Agent settings with temporary availability data. Visual inspection confirms all six
  additional marks and Hook controls in Chinese/dark and English/light views. It does not launch
  providers or restart the installed app; macOS/Linux visual acceptance remains pending. The tests
  retain Vite WebSocket-port/React act warnings and production builds retain the large-chunk
  warning.

### Agent installation

Settings → Agent and the standalone Agent panel include Claude, Codex, Gemini, OpenCode, Kimi, Grok,
Hermes, Pi, MiniMax, Qwen Code, Copilot CLI, iFlow CLI and TRAE CLI. Each uses the existing
project/chat launch flow and starts disabled.

1. For a missing program, select Install program, then confirm installation or open the official
   installation guide.
2. After installation, select Check again. Configure a custom executable path when needed.
3. Turn on Enable, then create a session from a project/Worktree row or the Add menu.

| Agent                                                                                                        | Default command | Installation entry                     |
| ------------------------------------------------------------------------------------------------------------ | --------------- | -------------------------------------- |
| [Hermes](https://hermes-agent.nousresearch.com/docs/getting-started/installation/)                           | `hermes`        | Official installer script              |
| [Pi](https://pi.dev/)                                                                                        | `pi`            | npm: `@earendil-works/pi-coding-agent` |
| [MiniMax](https://agent.minimax.io/docs/cli/quick-start)                                                     | `mcode`         | npm: `@minimax-ai/code`                |
| [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/)                                    | `qwen`          | npm: `@qwen-code/qwen-code`            |
| [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) | `copilot`       | npm: `@github/copilot`                 |
| [iFlow CLI](https://docs.iflow.cn/cli/quickstart/)                                                           | `iflow`         | npm: `@iflow-ai/iflow-cli`             |
| [TRAE CLI](https://docs.trae.cn/cli_get-started-with-trae-cli-2)                                             | `traecli`       | Official TRAE CLI 2.0 installer script |

- OpenCode, Claude, Codex, Gemini, Pi, MiniMax, Qwen Code, Copilot CLI and iFlow CLI support
  confirmed global npm installation. Node.js/npm, a version supported by the CLI and network access
  are required; installation does not elevate privileges. Only fixed package identifiers are
  accepted; installation runs off the UI thread, concurrent installs are rejected, and errors remain
  visible.

- Completion refreshes program detection; custom npm prefixes may require configuring the executable
  path or restarting uTerm. Kimi links to official installation instructions; Grok and custom
  executables require publisher-directed manual installation and path configuration.

- Detection preserves inherited PATH precedence. Default search paths include `~/.local/bin`,
  `~/.opencode/bin`, `~/.kimi-code/bin`, `~/.pi/agent/bin` and `~/.minimax-code/bin`. Windows also
  searches `%APPDATA%\npm`, `%LOCALAPPDATA%\hermes\bin`, `%USERPROFILE%\.minimax-code` and
  `%LOCALAPPDATA%\Programs\TraeCLI\bin`.

- Hermes downloads its official platform script and runs it without interactive setup, browser or
  computer-use installation. The download is limited to 1 MiB; execution is limited to ten minutes
  and 10 MiB of output. It does not elevate privileges or bypass PowerShell execution policy.
  MiniMax's npm installation includes optional dependencies and permits its SQLite install scripts.

- Complete provider login and model configuration in the CLI itself. Hermes, Pi, MiniMax, Qwen Code,
  Copilot CLI, iFlow CLI and TRAE CLI do not provide uTerm usage integration. The iFlow project has
  announced service shutdown; retaining its installer and Hooks does not guarantee that its hosted
  services are available.

#### Validation and limits

- Bilingual component tests cover confirmation, failure/retry, refresh, official installation links,
  enablement and the MiniMax `mcode` configuration default. Backend tests cover the package
  allowlist. Windows local-service fixtures verify all seven additional command mappings, default
  installation directories, inherited PATH precedence, launch command construction and custom
  program overrides.

- Windows validation passes 278 frontend/build-helper checks (11 optional/platform checks skipped),
  111 backend checks (nine ignored) and 38 local-service checks (two ignored). Tests cover custom
  identifier isolation, literal installer paths, MiniMax dependency flags, Hook reinstall/removal
  without unnecessary files or backups, retained user entries, malformed JSON, configuration
  conflicts and Pi's settled completion and closed reporter input. Formatting of the changed
  source/tests and Rust files, documentation, TypeScript/production and the isolated desktop build
  (`sh.uterm.desktop.qa.traebuild`) pass.

- Localization passes. These automated checks do not establish live provider, database or SSH
  acceptance.

- An isolated native Tauri/WebView2 fixture (`sh.uterm.desktop.qa.additionalagents`) renders the
  real Agent settings with temporary availability and settings data. Visual inspection confirms the
  six names, availability and switch alignment in the Chinese dark interface, English label
  switching and the MiniMax `mcode` field. The fixture does not launch provider CLIs or replace the
  installed app.

- Actual package downloads, authenticated Agent sessions and macOS/Linux runtime acceptance remain
  unverified.

### TRAE CLI

Open Settings → Agent → TRAE CLI, install the program, then enable it to create project, Worktree or
standalone chat sessions. The default command is `traecli`; Configure accepts an absolute program
path and a JSON array of arguments for custom installations. A `trae` editor launcher does not count
as the CLI.

Installation downloads the official TRAE CLI 2.0 platform script and runs it in the background with
unattended confirmation. The script download is limited to 1 MiB; execution is limited to ten
minutes and 10 MiB of output. PowerShell execution policy and installation errors remain visible.
Sign in and complete any first-run sandbox setup inside the CLI using an account with the required
access.

TRAE CLI uses its bundled brand icon and generic terminal notifications when emitted by the CLI.
Automatic uTerm Hooks, precise task-state events and usage/quota integration are unavailable.

#### Validation and limits

- Windows component fixtures verify bilingual installation confirmation, official guide links,
  program defaults, brand icons and enablement. Local-service fixtures verify `traecli` detection
  with an empty PATH, inherited PATH precedence, launch construction and custom program overrides.
  Backend checks verify official script URLs, unattended confirmation and literal script paths
  without Hermes-only arguments.

- All 17 focused frontend checks, 111 backend checks (nine ignored) and 38 local-service checks (two
  ignored) pass on Windows, together with formatting, localization, documentation,
  TypeScript/production and the isolated Windows desktop build. The full frontend/build-helper suite
  passes 278 checks with 11 optional/platform checks skipped.

- The isolated native Tauri/WebView2 fixture (`sh.uterm.desktop.qa.trae`) renders the real Agent
  settings with temporary availability and settings data. Visual inspection confirms the brand icon,
  availability, enable switch, `traecli` configuration and installation prompt in Chinese/dark and
  English/light views. The fixture does not install or launch TRAE or replace the installed app.

- Actual TRAE installation, authenticated model requests and macOS/Linux runtime acceptance remain
  unverified.

### Dismissing break reminders

Clicking blank space inside or outside a break reminder, or pressing Escape, does not dismiss it.
Use Keep working to close it manually, or wait ten seconds for automatic dismissal.

#### Validation and limits

- Component interaction and timer tests pass for these paths; native WebView interaction remains
  unverified.

### Break reminder settings layout

The break reminder switch and interval input share one row in General settings, without the
auto-dismiss helper text. Reminder timing and validation are unchanged.

#### Validation and limits

- A browser preview verifies the row alignment; bilingual component tests check both controls and
  removal of the helper text.

### Break reminder timing

Settings → General includes a Break reminder switch (off by default) and an interval of 1–1440 whole
minutes (default 60). Interval edits save on leaving the field.

- While the app runs, a non-blocking reminder appears without taking focus, closes automatically
  after ten seconds, and can be dismissed with Keep working. Dismissal restarts the interval;
  changing the interval or restarting the app also resets it.

- Disabling cancels pending reminders. Missed intervals during sleep are not queued, and the app
  does not force its window to the foreground.

#### Validation and limits

- Timer and settings regression tests cover automatic/manual dismissal, cleanup and invalid values;
  native timing and visual acceptance remain pending.

### Resetting interface settings

The global Reset interface and terminal settings action appears only in Settings → General. Other
settings categories do not repeat it, so its scope is distinct from category-specific controls.

Resetting keeps the existing backup and visible error behavior.

### Launch at login

Settings → General → Launch at login controls automatic startup after OS sign-in on Windows and
macOS. Login startup keeps the main window hidden and runs in the system tray (macOS menu bar);
click the tray icon to open it.

Right-click the tray icon and left-click **Launch at login** to turn it on or off. A check mark
means startup is enabled. This item and the General settings switch share the same system
registration; changes also update an open settings dialog. The menu follows the application's
language.

- Manual launches and session links still open the window, while repeated background launches leave
  an existing window hidden. For an existing startup entry, turn this setting off and on to apply
  background startup.

- Opening settings reads the system registration without enabling it. Changes apply immediately;
  failures remain visible and can be retried. A failed tray-menu change restores the last confirmed
  check mark and shows an error dialog.

- Resetting interface settings does not change the OS registration. Development builds use a
  separate startup entry.

#### Validation and limits

- On Windows, all 22 focused taskbar, settings/localization and highlight-setting checks pass,
  including bilingual tray labels, enabling/disabling, failure recovery and updates to an open
  settings dialog from mocked tray events. TypeScript and the production frontend build pass. An
  isolated browser preview verifies the General settings layout.

- Windows backend checks pass with 107 tests passed and nine optional checks ignored. The isolated
  desktop build (`sh.uterm.desktop.qa.tray-autostart`), localization and documentation checks pass.
  Native startup and visual inspection confirm that background startup keeps the main window hidden
  and a subsequent manual launch shows the application without startup errors.

- Actual OS sign-in, visual tray-click acceptance and macOS acceptance remain pending.

### Agent definitions and activity

Agent definitions specify a program and argument list. Structured events and native terminal
reminders report activity; Hooks remain optional. Usage can combine local logs with provider
requests when enabled.

Custom identifiers keep their own configuration actions and do not inherit built-in installation
guides or defaults, including identifiers such as `constructor`.

Provider credentials and permissions determine availability. Terminal input and process I/O are
handled independently of UI rendering.

### Installing and removing Hooks

Settings → Agent → Install Hooks configures Claude, Codex, Gemini, Pi, MiniMax, Qwen Code, Copilot
CLI and iFlow CLI. Reinstalling keeps one uTerm reporter per supported event, replacing recognized
entries from other release, development or QA installations even when their paths differ.

- Remove Hooks also removes these recognized entries for the selected Agent. Other tools' commands
  and settings, including commands in the same group, are preserved.

- Unchanged Hook configurations are not rewritten or backed up again. Removing absent Hooks does not
  create configuration files or extensions; unrelated empty Hook groups are preserved.

- Only literal standalone uTerm reporter commands are managed; double-quoted command substitutions
  or variable expressions, custom wrappers and combined shell commands remain untouched.
  Configuration conflict checks and backups remain in effect, and changes apply to new Agent
  sessions.

| Agent       | Hook file or extension                     | Activity                                     |
| ----------- | ------------------------------------------ | -------------------------------------------- |
| Qwen Code   | `~/.qwen/settings.json`                    | Idle, working, permission waiting, completed |
| iFlow CLI   | `~/.iflow/settings.json`                   | Idle, working, notification, completed       |
| Copilot CLI | `~/.copilot/hooks/uterm-activity.json`     | Idle, working, completed                     |
| Pi          | `~/.pi/agent/extensions/uterm-activity.js` | Idle, working, settled completion            |
| MiniMax     | `~/.minimax/plugins/uterm-activity/`       | Idle, working, permission waiting, completed |

Copilot uses direct executable/argument entries. Pi runs its reporter off the UI thread, closes the
reporter's input and waits for `agent_settled`, so an intermediate `agent_end` does not report a
finished task. Pi requires a version that exposes this event; update older installations. Pi and
Copilot do not report a separate permission-waiting state.

MiniMax uses a local compatible plugin. If it was manually disabled, enable `uterm-activity` in
`/plugins`. Custom directories honor `COPILOT_HOME`, `PI_CODING_AGENT_DIR`, `MINIMAX_DATA_DIR` and
`MAVIS_DATA_DIR`; set the MiniMax data directory to the active custom profile when applicable.
Existing hook-disable settings and unrelated plugins are preserved. Remove Hooks leaves Pi's
extension inactive and removes uTerm commands from the JSON configurations, retaining backups.

Hermes provides a Hook setup guide instead of automatic uTerm state integration. Its shared gateway
can serve multiple terminal clients without their individual uTerm environment, so gateway hooks
cannot reliably identify a terminal session. Follow its official guide for manual hooks; enabling
them does not establish uTerm session-state integration.

### Windows Hook commands

Windows Hooks explicitly invoke PowerShell with a literal executable path, so PowerShell and cmd.exe
runners support spaces, Chinese and shell metacharacters without treating the quoted path as an
expression. To configure reporting, select Install Hooks and open a new Agent session.

Other tools' Hooks remain independently configured and may need their own Windows commands.

### Notifications without Hooks

Enable Settings → Agent → Notify when tasks finish or need attention, then open a new Agent session.
The original interactive terminal interface is retained. Installing Hooks is optional.

| Agent                                                                                | Notification source                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex                                                                                | A dedicated authenticated loopback app-server and the original TUI connected through `--remote`; unsupported versions or invocation-specific configuration use terminal reminders. |
| OpenCode                                                                             | Its own authenticated loopback server and SSE session/permission events. Custom server or attach arguments retain terminal reminders.                                              |
| Claude                                                                               | A terminal bell enabled for this launch with `--settings`; explicit later CLI settings retain precedence.                                                                          |
| Gemini, Kimi, Grok, Hermes, Pi, MiniMax, Qwen Code, Copilot CLI, iFlow CLI, TRAE CLI | Native terminal notifications or BEL when the CLI emits them. Availability and enablement depend on the CLI version and settings.                                                  |

- All thirteen built-in Agents, custom Agents and ordinary terminals share the OSC 9, OSC 777, basic
  OSC 99 and BEL reminder channel. A generic signal displays “Session has a new notification” with
  an amber indicator; it never establishes task completion or permission waiting. Viewing the
  session acknowledges the reminder. OSC title, clipboard, directory and progress controls do not
  trigger reminders.

- Generic reminders also appear in the tray task list with an amber attention indicator and their
  own label. Failure labels say “Task failed”, including failures while the Agent process remains
  running.

- Codex invocation-specific profiles, config/feature overrides, OSS selection, worktree creation and
  starting-directory overrides retain the original local launch with terminal reminders, so an
  independent server cannot silently change those settings. Configuration from `CODEX_HOME` remains
  available to the managed event server.

- Codex and OpenCode use structured status to distinguish work, completion, attention and failure.
  Codex excludes subagents and temporary helper threads and supports both paginated and legacy
  history. A cancelled Codex turn does not report success. OpenCode ignores child sessions and
  requires observed work before reporting completion; an error followed by idle is not completion.

- Native reminders may require a CLI setting: Gemini uses `general.enableNotifications`; Hermes
  offers `display.bell_on_complete`; Copilot uses `beep`. Other CLIs must emit a supported terminal
  notification or bell themselves. If no signal is emitted, only process exit can be detected;
  silence, CPU usage and displayed prose are not treated as completion. Process-exit notifications
  say “Session ended” on success or “Session exited with an error” on failure, independently of a
  turn completing while its process remains alive.

- Each event has its own ID, so consecutive completed turns can notify without an intervening
  working frame. Up to 128 recent events are retained per session. Replay and reattachment do not
  resend history, and acknowledging an older event does not clear a newer one. Bell bursts are
  combined, and structured events take precedence over terminal reminders and compatible Hooks.

- Event connections stay on authenticated loopback endpoints and retry after disconnection. Their
  errors appear separately from terminal connection errors and clear after recovery. Existing Hooks
  and user configuration files are preserved. Codex WebSocket app-server transport remains
  experimental upstream; unsupported API behavior is visible and retains terminal reminders.

- Starting an Agent's event service does not hold the session-list lock, so existing sessions remain
  available while a CLI probe or server startup is pending. New-session creation and safe host
  shutdown remain serialized.

- Existing host processes keep their current capabilities until safely replaced; existing sessions
  are not restarted automatically. Notifications require the application to remain running,
  including in the background. Reopening after quitting restores state without sending historical
  notifications. SSH and terminal-multiplexer forwarding remain dependent on those tools passing the
  escape sequences through.

#### No-Hook notification validation

Windows host regressions cover every built-in Agent's generic event path, split escape sequences,
non-notification controls, replay, independent event IDs and structured-event precedence. Frontend
regressions cover old-host frames, invalid event metadata, repeated completed turns, generic copy,
failure copy, native permissions and duplicate suppression.

- Windows serial host checks pass (38 checks); two installed-CLI checks run separately and pass.
  Serial backend checks pass (108 passed, nine opt-in checks ignored). Serial execution avoids
  process-startup and executable-cleanup timing failures in the QA environment.

- The complete frontend/build-helper suite passes (273 passed, 11 optional/platform checks skipped).
  Focused checks cover batched font adjustments, tray reminder labels, repository switching, legacy
  Codex turn ordering and retaining custom invocation settings. A slow-CLI regression verifies that
  host requests remain responsive during startup.

- Changed-source/test and Rust formatting, localization, documentation, TypeScript/production and
  Windows desktop checks pass. Vite's WebSocket-port and large-chunk warnings remain.

The installed Codex CLI 0.163.0 runs its real TUI against an isolated deterministic loopback model
fixture, with no Hooks or real provider credentials. Two successive turns produce distinct
authenticated completion events, and closing the session removes its temporary authentication file.
OpenCode CLI 1.18.32 runs its original TUI with authenticated SSE and rejects unauthenticated
requests; it makes no model request in this check. A loopback SSE fixture covers child-session
filtering, permissions, failures and completion.

An isolated native Tauri/WebView2 app (`sh.uterm.desktop.qa.nativeactivity`) renders the real
settings and indicators with fixture availability. Chinese/dark and English/light screenshots
confirm the six-pixel generic reminder indicator, labels and notification description without
horizontal overflow. A real native tray sync accepts the generic reminder with attention status; two
file-font increments and one diff-font increment persist independently before another render. The
installed app and active sessions are not restarted. Real-provider acceptance for all Agents,
installed notification delivery/branding and macOS/Linux runtime acceptance remain unverified.

### Agent state and notifications

The sidebar and Agent pane header display the same idle, working, needs-attention or completed
state, plus a distinct generic-reminder state. Unviewed completion highlights the sidebar icon until
acknowledged.

- Settings → Agent → Notify when tasks finish or need attention is off by default and requests
  permission through the native notification service when enabled. The switch and delivery checks
  use native permission results, so a stale WebView denial does not block enabling native
  notifications. A failed permission request or preference save leaves the switch unchanged and
  displays an error. Completion and attention notify when the app is unfocused or another session is
  selected; development builds, restored history and repeated identical states do not send
  notifications. Independent events from capable hosts are deduplicated by event ID rather than
  state, so successive completed turns can each notify.

- Pending permission results are ignored after a newer Agent state, session closure or view unmount;
  dispatch also rechecks the current notification setting, focus and selected session. Native
  dispatch failures remain visible.

#### Hook and notification automated checks

- Hook regressions cover idempotent installation, old/encoded paths, mixed groups, removal,
  unrelated commands, preservation of dynamic shell expressions, no-op file/backup protection and
  actual PowerShell/cmd execution with literal special-character paths.

- Notification and settings regressions pass. The App regression covers indicator states, unread
  acknowledgement, opt-in, focus, native permissions, replay, duplicate suppression, development
  builds and dispatch failures. Deferred permission checks verify cancellation after opting out,
  viewing/closing a session, receiving a newer state or unmounting, including delivery of only the
  latest pending state.

- Settings coverage includes a denied WebView cache with native permission granted, native
  permission requests, denial, query/save failures, pending requests, provider reload and disabling
  without requesting permission.

- Changed-source/test and Rust formatting, localization, documentation checks, TypeScript/production
  and the isolated Windows desktop build (`sh.uterm.desktop.qa.nativeactivity`) pass. Tests/builds
  retain the Vite WebSocket-port and large-chunk warnings.

- Permission and deferred-notification regressions use mocked native commands. Native acceptance of
  enabling and delivering notifications through the updated permission path in installed Windows
  builds, installed notification branding, authenticated providers and macOS/Linux acceptance remain
  unverified.

#### Hook and notification native checks

- An isolated native app (`sh.uterm.desktop.qa.agenthooks`, unoptimized with the production
  notification gate enabled) runs the installed Codex CLI 0.163.0 against a deterministic loopback
  model fixture. Real prompt/Stop Hooks update both working/completed indicators without Hook
  failures, and the completed sidebar icon glows.

- Executing the generated attention Hook with 64 KiB of stdin verifies yellow indicators;
  acknowledgement clears completion. Windows toast history confirms completion and attention
  messages.

- Repeated attention reports and reattachment do not resend notifications, and repeated installation
  retains one reporter per event. A combined CLI smoke test also preserves another tool's
  Windows-specific Hook overrides with its remote-session environment cleared.

- The unpackaged QA app uses the notification plugin's PowerShell identity; installed-app
  notification branding, authenticated provider runs and macOS/Linux runtime acceptance remain
  unverified. The user's active app and sessions are not restarted.

### Appearance and terminal preferences

Settings include appearance, color themes, fonts, terminal cursor and scrollback, keyboard
shortcuts, default shell and Agent. Theme import accepts supported color fields only.

### Terminal text selection and rendering

Visible terminal and Agent panes use GPU rendering when WebGL2 is available. Dragging to select text
updates the highlight without rebuilding the visible text nodes at every mouse movement. Copy
shortcuts and the optional Copy on selection setting retain their existing behavior.

Only visible panes keep GPU contexts; grouped panes can each use one. Hiding a pane releases its
context while preserving the session, scrollback and selection. Hidden panes leave the page layout,
pausing DOM rendering and screen-reader row measurements. They continue consuming and acknowledging
output; showing them resumes rendering and the screen-reader text layer without restarting sessions.

Unsupported GPUs, initialization failures and context loss that cannot be restored fall back to DOM
rendering automatically. This fallback can still slow down when selecting dense output.

Live screen-reader announcements retain at most 8,192 UTF-16 code units, including the overflow
message. Older announcement text is discarded when applications redraw without line feeds. The
readable terminal rows, scrollback, selection and input remain intact.

#### Selection-rendering checks

- On macOS, all 28 focused accessibility, renderer, input, scrolling and resize regressions pass.
  The full frontend suite passes (280 passed, ten optional/platform checks skipped), alongside
  repository formatting, localization, TypeScript, the production build and desktop compilation. The
  production build retains its large-chunk warning. Locked dependency installation, local-session
  service tests and backend tests pass; the backend suite has 114 passes and nine opt-in checks
  ignored.

- An isolated native Tauri/WebKit app (`sh.uterm.desktop.qa.terminalselection`) uses the real
  terminal view and 600 rows of colored Chinese/English fixture output. Across 120 selection
  updates, visible-screen node additions/removals fall from 424,257 with DOM rendering to zero with
  GPU rendering; the longest measured frame falls from 66 ms to 18 ms. These fixture measurements do
  not guarantee the same frame timings on other hardware or live workloads.

- Native mouse dragging shows multi-line selection highlights. Injected context loss returns to DOM
  rendering, retains selection and accepts more output; showing the pane again enables GPU
  rendering.

- An isolated macOS Tauri/WebKit fixture (`sh.uterm.desktop.qa.selectionfreeze`) exercises eight
  real terminal views, 300 simulated project entries and 180 frames of colored Chinese/English
  output and selection updates. Pausing hidden views reduces the measured 95th-percentile frame time
  from 233 ms to 20 ms and accessibility-row measurements from 10,416 to 126. These fixture timings
  are hardware/load dependent and do not establish live Agent acceptance.

- The same fixture verifies hidden-session replay and live output, with both frames acknowledged.
  Hiding/showing preserves selected text and coordinates, restores the visible screen-reader layer
  and keeps the start count at eight. Native mouse dragging and subsequent input remain responsive.

- The installed macOS app (0.1.37) reproduces the whole-window stall when the existing Codex session
  is scrolled and selected manually. During the confirmed stall, a three-second sample stays almost
  entirely in WebKit's `characterIndexForPoint` / `previousCandidate` text traversal and CPU usage
  approaches 100%; a window screenshot request also times out. This is separate from background
  rendering overhead.

- The accessibility regression covers repeated redraws without line feeds, Chinese/emoji boundaries,
  retained readable rows and selection, replacing the accessibility layer and observer disposal. An
  isolated native Tauri/WebKit fixture (`sh.uterm.desktop.qa.selectionhittest`) writes 8,000
  cursor-based redraws without line feeds through the real terminal. Announcements remain bounded at
  8,192 code units, retain the latest text and preserve all 43 readable row elements and the input
  textarea.

The announcement limit still needs acceptance in the installed app against the same live Codex
session; the running installation was not replaced or restarted. Clipboard shortcut routing remains
covered by automated tests; native clipboard, grouped-pane acceptance and Windows/Linux runtime
checks remain pending.

### Content font shortcuts and session headers

Use Ctrl+- to decrease or Ctrl++ to increase the font of the content shown in the middle workspace.
Ctrl+= also increases it; Ctrl+Shift+= produces Ctrl++ on common keyboards. macOS uses Command in
place of Ctrl. Settings → Shortcuts provides Decrease content font size and Increase content font
size; existing custom shortcuts keep priority over these defaults.

Terminal and Agent sessions share the terminal font setting. Text, HTML source and Markdown use the
file setting; an expanded Git diff in the middle workspace uses the Git diff setting. These three
sizes are independent, change by 1 px within 10–32 px and save immediately. Consecutive adjustments
retain each increment, including when different content types change before the next render. Images,
PDF and static HTML previews keep their existing sizing behavior. Dialogs and context menus retain
their own keyboard handling.

Session headers show the configured starting directory beside the session name, with the complete
path in its tooltip. This directory does not follow shell `cd` commands. Long paths truncate to keep
**A−**, the current pixel size and **A+** accessible. The buttons adjust the shared terminal font
setting and disable at its bounds; save failures appear in the session.

#### Windows checks and limits

- All 29 focused settings, path, viewer-header, content-font and file-menu tests pass. Coverage
  includes Ctrl and Command combinations, the shifted plus alias, custom-binding priority,
  independent saved sizes, menu targets and visible failures. TypeScript, localization,
  production/native QA builds and changed-file formatting checks pass; the production build retains
  its large-chunk warning.

- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.contentcontrols`) runs the real App,
  shell and temporary Git project. Native key input verifies all three font targets, terminal input
  suppression, terminal buttons and the upper bound, and retained CodeMirror instance/selection.
  Visual inspection covers session headers, file text and an expanded Git diff in Chinese/dark, plus
  the header and menu in English/light at 1000 × 700. Clipboard and reveal calls are mocked; no
  model requests are used. macOS/Linux runtime acceptance remains pending.

### Mouse wheel and trackpad scrolling

Terminal and Agent panes use small steps for slow mouse-wheel scrolling and accelerate consecutive
faster turns. A typical isolated notch moves about one history row; faster same-direction input
increases the multiplier up to six times.

- Pausing for more than 200 ms, reversing direction or changing the scrolling context resets
  acceleration and fractional carry. Fine trackpad pixels retain proportional distance and
  fractional accumulation without extra acceleration; larger pixel deltas and line-based events use
  wheel normalization, since browsers do not identify the physical device.

- Alt/Option adds its existing speed multiplier. Horizontal/Shift and Ctrl/Cmd gestures retain their
  existing handling.

- History moves immediately, bounded to four viewports per event; page-based events move by viewport
  height. Application scrolling keeps xterm's original mouse or cursor-key encoding, with at most 12
  steps (or the pane's row count when smaller) per event, combined into one input write.

- Applications decide how many rows each step moves; saved scrollback limits still apply.

#### Scrolling checks on Windows

- Scrolling validation on Windows: all 17 focused input/scroll regressions, changed-source/test
  formatting, localization/documentation checks and TypeScript/production build pass. A probe of
  1,000 discrete wheel events and ten page events records zero layout measurements; a fine pixel
  event still measures the rendered row height.

- Tests cover slow/fast pixel and line notches, bounded acceleration, pause/reversal/context resets,
  fractional trackpad input, modifiers, mouse protocols, disabled input and cleanup. An isolated
  native Tauri/WebView2 host (`sh.uterm.desktop.qa.terminalscroll`) runs seven scenarios with the
  real xterm renderer and injected wheel events: four 300 ms-spaced notches move four history rows,
  four 30 ms-spaced notches move 13, and eight 2 px events move one row.

- SGR/legacy binary mouse and alternate-screen cursor reports retain encoding and use one batched
  input write per event; disabled application input sends nothing. The fixture uses no real
  processes or Agent credentials and does not restart the installed application.

- Physical-wheel/trackpad feel, live Agent behavior and macOS/Linux runtime acceptance remain
  pending. The production build retains its large-chunk warning.

### File and Git diff font sizes

Settings → Appearance provides independent File font size and Git diff font size controls alongside
the existing font controls. Both default to 14 px and accept whole numbers from 10 to 32 px.

File viewing also provides **A−**, the current pixel size and **A+** in the file header, before the
save status. Each click changes the shared file font size by 1 px and saves it immediately. The
buttons disable at the size limits and are available for editable/read-only text, HTML source and
Markdown previews. Image, PDF and static HTML previews keep their own sizing controls or styles.

- Enter or leaving the field applies and saves the value; existing files and diffs update
  immediately, and the values persist across restarts. File font size covers editable/read-only text
  and Markdown previews, with headings and code scaling proportionally.

- Git diff font size covers working/staged changes, branch comparisons and commit history in
  unified, side-by-side and expanded views. Interface and terminal sizes remain independent; PDF
  zoom and HTML page styles retain their existing behavior.

- Older version-1 settings receive the defaults for missing fields; invalid values and save failures
  remain visible without replacing saved data. Reset interface and terminal settings resets both
  sizes.

- Font changes preserve the mounted editor, draft, selection and undo history and do not save or
  reload the file.

#### Font-size checks on Windows

- Windows validation: 21 content-font, settings and localization tests pass, including toolbar
  clicks, 10/32 px disabled states, immediate persistence, visible save failures and retry,
  old-setting defaults and independent font settings. The real CodeMirror regression retains its
  instance, unsaved text, selection and undo history, covers read-only text/Markdown switching and
  all Git diff modes with portal expansion, and confirms that font changes do not save files or
  reload diffs.

- Production build, TypeScript, localization, documentation and changed-file formatting checks pass.
  The production build retains its large-chunk warning.

- An isolated Windows Tauri/WebView2 fixture (`sh.uterm.desktop.qa.filefont`) runs the real file
  editor with sample documents and mocked desktop commands. Native clicks verify immediate sizing,
  retained drafts/selection, disabled limits, save failure/retry and persistence after reloading.
  Visual inspection covers Chinese/dark text at 20 px, English/light text at 32 px in a 640 px
  viewport and Markdown at 20 px. HTML source offers the buttons; static HTML and image previews
  hide them. No real file writes are used.

- The expanded unified Git diff was visually checked with the content shortcuts above; other Git
  diff layouts and macOS/Linux runtime acceptance remain pending.

### Automatic updates and confirmation

Settings → Software update → Automatic updates is off by default and persists across restarts. In
builds with online updates enabled, turning it on checks immediately and then hourly while running,
automatically downloads available updates, verifies their signature through the existing updater,
and prompts before installing and restarting.

- The confirmation dialog offers Install now and Cancel, with automatic installation after ten
  seconds without a response. Cancel or Escape stops the countdown and suppresses automatic
  installation of the same version for this run; manual installation remains available in Software
  update.

- Manual Install and restart uses the same confirmation. Closing settings does not dismiss the
  prompt.

- Disabling automatic updates cancels an automatic prompt. Turning it off stops future automatic
  steps; an already running download may finish.

- Unsaved files block installation through the existing editor guard. Failures are shown in Software
  update and stop automatic progression until a manual retry.

#### Validation and limits

- Hook tests cover opt-in behavior, automatic download, installation guards, restoration after
  failure, avoiding retry loops and manual retry; settings tests cover old-data defaults and
  validation. All 159 frontend/build-helper tests, formatting, localization, documentation checks
  and frontend/isolated macOS desktop builds pass.

- Native QA (`sh.uterm.desktop.qa.autoupdate`) verifies the switch layout and disabled state in a
  build without online updates. Actual signed download/install/restart and Windows runtime
  acceptance remain pending.

#### Update-confirmation checks

- Update confirmation validation: all 159 frontend/build-helper tests, formatting,
  documentation/localization checks, frontend production and isolated macOS desktop builds pass.
  Hook/component tests cover cancel-button focus, cancellation preventing timeout installation,
  ten-second installation, duplicate confirmation guards and unsaved-file protection.

- A browser preview of the real dialog component verifies the Chinese layout and Cancel button. The
  preview uses mock update callbacks; native signed-update confirmation, installation/restart and
  Windows runtime acceptance remain pending.

### Update progress and release notes

Settings → Software update checks for updates after startup. Progress, action buttons and error
messages appear before Release notes at the bottom.

Release notes render Markdown headings and lists with spacing and their own scrolling region, so
long notes do not push actions below them. HTML, images and interactive content are excluded.

Component regression checks verify headings/lists, excluded script elements and progress/install
controls preceding notes. All 159 frontend/build-helper tests and the frontend production build
pass; native signed-update notes and Windows runtime acceptance remain pending.

While an update downloads, and after its download has completed, its progress bar remains visible
with the downloaded size immediately beside it. A completed update additionally reports successful
signature verification before Install and restart is available.

The bilingual settings component regression test covers this completed-download layout;
signed-update runtime acceptance remains pending.

### Terminal clipboard shortcuts

In a focused Windows terminal, Ctrl+C copies selected terminal text; without a selection it remains
the terminal interrupt key. Ctrl+V and Ctrl+Shift+V paste clipboard text using the terminal's
bracketed-paste mode when enabled.

- Ctrl+Shift+C also copies selected text. macOS sends Cmd+C/Cmd+V through native copy/paste events
  to xterm, without requesting asynchronous browser clipboard access: pasting needs no extra WebKit
  “Paste” click and does not produce that API's `NotAllowedError` banner. Control keys remain
  available to terminal programs.

- Native paste retains bracketed-paste handling and disabled-input protection. Other clipboard and
  session failures remain visible; a pending asynchronous paste is discarded if its connection
  closes or changes.

#### Validation and limits

- Shortcut regression tests cover native macOS routing, selection states and Shift modifiers,
  alongside Windows copy/paste and Control passthrough; native acceptance is recorded below.

### Input-method punctuation

Terminal and Agent sessions let the input method transform punctuation before forwarding committed
punctuation through the normal terminal input queue. After pasting text, use Left/Right to move the
terminal cursor and continue typing Chinese at that position without resending old text.

Before new typing or composition starts, the hidden input field's caret is aligned with the end of
its committed value, independently of the terminal cursor. Its value, active composition, paste,
navigation and Control/Alt/Meta shortcuts are preserved, and disabled input is respected.

#### Validation and limits

- Ten focused tests cover Chinese and ASCII punctuation, composition boundaries, cancellation,
  disabled input and listener cleanup, including real xterm composition and key-229 input after
  caret movement. The frontend/build-helper suite passes 283 tests with ten optional/platform checks
  skipped. Formatting, localization, TypeScript/production build and an isolated macOS desktop build
  pass.

- Native macOS QA (`sh.uterm.desktop.qa.imeediting`) uses the real Terminal view with a mock input
  receiver. Injected composition verifies Chinese insertion after paste and Left; native paste,
  Left/Right and trusted input-method commits, including Chinese text, send only the new committed
  text at the requested position. Acceptance in the user's live Agent session and Windows/Linux
  runtime acceptance remain pending. The installed application was not replaced or restarted.

### Update download retries and caches

Update downloads make at most three attempts for transient connection/server failures, preserve
partial bytes across restarts, and reuse complete disk caches only after checking the current public
key, Minisign signature and signed-version policy. Unsupported or inconsistent Range responses
restart the download.

- Verification runs off the UI thread before the existing installer, confirmation and
  session/editor/database/Redis/SFTP guards. Network, timeout, certificate, missing-file,
  access-denied, rate-limit, server, metadata/response and cache-storage errors have separate
  bilingual guidance.

- Software update always offers Download installer manually, including builds without online
  updates. Cache cleanup runs on use, retaining the selected file and at most three other files
  within a 512 MiB budget and removing inactive files older than seven days; each update is limited
  to 512 MiB.

- Downloads still require access to their configured source.

### Agent package download failures

Agent installation continues through npm with its existing cache and user registry/proxy
configuration. Package fetches allow two retries, 2–10 second retry delays and a 120 second request
timeout, within the existing ten minute installation limit.

- Permission and Node.js-version failures are distinguished from network failures; raw installation
  output remains available. The installation command and lifecycle scripts are never automatically
  rerun.

- Official installation instructions remain available.

### Windows installer launch

Windows launches a temporary `.exe` copy after validating a cached installer, preserving the normal
installation wizard and elevation behavior. The cached `.part` remains reusable; the launch copy is
removed when the script exits.

This requires temporary disk space for one additional installer payload.

#### Download checks on Windows

- Download validation on Windows: 82 backend checks pass, including bounded retries, resumed
  prefixes, complete-cache reuse, ignored/malformed ranges, permanent HTTP failures, long
  Retry-After, storage/cancellation/certificate classification and signed content/key/version
  rejection. The PowerShell integration check uses real loopback HTTP and a disposable native
  Windows executable in place of an installer to cover 503, interrupted responses, resume,
  verified-cache reuse, actual process launch, modified-content rejection and 404 without
  installation retries.

- Frozen dependency installation, the complete frontend suite (228 passed), 31 affected-module
  checks, 15 UI/localization regressions, seven Windows installer/release-helper checks and 24 host
  checks pass; ten optional/platform frontend checks are skipped. Changed-file formatting,
  localization, documentation and TypeScript/production checks pass.

- Native isolated Windows QA (`sh.uterm.desktop.qa.downloads`) inspects the actual
  settings/components views in English/dark at 900×650 and Chinese/light at 640×600, and confirms
  the manual-release target with mocked external navigation. No real packages are installed.

- The isolated desktop build uses `sh.uterm.desktop.qa.downloadcheck`; the installed app is not
  restarted. The production build retains its large-chunk warning.

- Real signed application installation/restart, Agent package installation and macOS
  installer/runtime acceptance remain unverified.

## Interface

### Shared close icons

In-app close icons share a small circular ×: gray by default and muted red on hover. This applies to
dialog headers, file/diff tabs, session controls, terminal search, SQL query tabs and Redis
drawer/field-editor controls.

Sidebar session rows show only the × at rest, revealing its circle on hover or keyboard focus.
Existing actions, accessible names, disabled states and keyboard focus are retained, including the
Redis drawer close control's responsive visibility.

Settings and the Agent dialog initially focus their titles, so opening them does not draw an extra
outline around the close icon. Tab moves to the close button and shows its keyboard focus outline;
Enter activates it, and Escape dismisses the dialog when closing is allowed.

#### Close-icon checks

- Close-icon validation on macOS: 274 frontend/build-helper tests pass, with ten optional/platform
  checks skipped. Repository formatting, localization, TypeScript checks, production frontend and
  isolated desktop builds pass. The build retains its large-chunk warning; tests report an occupied
  Vite WebSocket port without failures.

- Native QA (`sh.uterm.desktop.qa.dialogfocus`) verifies Settings and Agent titles receive initial
  focus without an outline around the title or close icon. Tab reveals the close button's focus
  outline; Settings closes with Enter, and Agent closes with Escape or a mouse click. Native
  Redis/database close controls and Windows/Linux runtime acceptance remain unverified.

### macOS window controls

On macOS, the close, minimize and zoom/full-screen controls use the original system window buttons
at their system-managed positions, without custom offsets. macOS manages their hit areas, colors,
hover symbols, accessibility and full-screen menu. The 56 px title bar reserves space for the
buttons.

Closing hides the window while keeping sessions; the buttons remain usable above application
dialogs.

The title bar shares the sidebar background, including when the sidebar list is collapsed. In the
Icon navigation sidebar, the rail background and divider start below the 56 px title bar, with an 8
px gap before the first navigation button. The window buttons keep a continuous background and clear
separation from navigation controls in both light and dark themes.

The sidebar title bar has a 1 px bottom divider aligned with the main toolbar, separating the window
controls and workspace name from the navigation and project lists.

#### macOS window-button checks

- macOS validation: 258 frontend/build-helper tests pass with ten optional checks skipped; 108
  backend tests pass with nine optional tests ignored, and local-session service tests pass. Locked
  dependency installation, repository formatting, localization/documentation checks and
  TypeScript/production build and desktop compilation pass. The production build retains the
  existing large-chunk warning.

- Native QA (`sh.uterm.desktop.qa.titlebarhover`) checks the continuous divider in Black and Paper
  themes with the Icon navigation sidebar expanded and collapsed. The system
  close/minimize/full-screen accessibility roles are present; the green button enters full screen
  and Ctrl+Cmd+F exits it.

- The macOS screen-capture badge obscures the buttons, so the corrected hover behavior has not been
  directly visually accepted in this capture session. Windows/Linux runtime checks were not run for
  this macOS-only layout change.

### macOS menu bar

The macOS menu bar provides the same commands as the application controls and command palette.

- **uTerm** opens Settings, Agent configuration and About, with the standard Services, Hide and Quit
  actions. **File** adds projects, opens terminals or chats, quickly opens files and closes the
  current session, file or workbench. Close Window hides the window and keeps sessions running.

- **Edit** provides native undo, redo, cut, copy, paste and select-all actions for the focused
  control. **View** opens the command palette, toggles the sidebar and inspector tools, swaps panes
  and searches the project.

- **Session** switches to the previous or next session, or selects one by workspace and project, SSH
  connection or standalone session type. It also provides splitting, pane focus, zoom, Ungroup,
  terminal search and Copy session link.

- **Workspace** creates or selects a workspace. Current sessions, workspaces and visible panels are
  checked. **Window** provides native minimize, zoom, full-screen and bring-to-front actions.
  **Help** opens the feature guide, website and issue form.

Menu labels follow Settings → General → App language immediately. Help links select the matching
guide and website language; user-entered names keep their original text. macOS manages the language
of system-provided Services entries and other system additions.

Command shortcuts follow Settings → Keyboard shortcuts, including custom and disabled bindings.
Unavailable actions are disabled; dialogs and pending file operations block session and workspace
changes. File switching and Quit retain the existing draft, conflict and exit safeguards.

#### Menu-bar checks on macOS

- On macOS, 258 frontend/build-helper tests pass with 10 optional/platform checks skipped, and 108
  backend tests pass with 9 ignored. Repository formatting, localization/documentation checks,
  TypeScript/production build and an isolated desktop build pass. The production build retains its
  large-chunk warning.

- Automated checks cover bilingual labels, stable session/workspace targets, SSH and Worktree
  grouping, panel checks, custom and disabled shortcuts, dialog guards, stale menu replacement and
  visible native-menu failures. Native menus are installed only on macOS.

- An isolated Tauri app (`sh.uterm.desktop.qa.macosmenu`) uses the real App and native menu APIs
  with temporary workspaces and simulated sessions. Native inspection verifies menu clicks, sidebar
  switching with Cmd+B, Settings with Cmd+Comma, cross-workspace session selection, workspace
  selection, a custom Cmd+Option+L binding and immediate Chinese/English switching. Session actions
  are disabled while Settings is open. Names containing an ampersand remain intact.

- Real process/SSH switching, dirty-file exit interaction and system-managed menu additions remain
  unverified. Native popup screenshots are unavailable in the current capture tool; menu labels and
  resulting application states are verified through native accessibility.

### Inspector tools and panel toggles

The inspector's Files, Git, GitHub and Working directory icons share a rounded capsule with a fine
border. Each icon has a circular hover/selected background. The selected tool's icon uses the
highlight color and retains it on hover; the other icons retain their normal colors. Connection
visibility switches and the selected sidebar navigation icon use the same highlight color.

Settings → Appearance → Icon highlight defaults to Follow theme, using the current interface theme's
accent color as the theme or color mode changes. Older saved settings also use this default.

- Choose Custom color to use the color picker or enter a six-digit hexadecimal color such as
  `#62d98a`. Press Enter or leave the text field to apply it. Changes save automatically and persist
  after restart; a custom color stays the same across themes and dark/light modes.

- Choose Follow theme to restore automatic colors. Restore interface and terminal defaults also
  restores this mode. Invalid colors or failed saves show an error and retain the saved highlight.

- The sidebar hide/reopen and inspector show/hide buttons show only their icons at rest, adding a
  circular background and border on hover or keyboard focus. The sidebar hide icon aligns with the
  section actions below it; the right-side inspector toggle has an 8 px inset from the toolbar edge.

- Both retain a 36 px click target. These controls follow the selected interface palette in both
  dark and light modes and retain visible keyboard focus.

#### Panel-toggle alignment checks

- Panel-toggle alignment validation: source formatting, TypeScript/production build and an isolated
  macOS desktop build pass. Native QA (`sh.uterm.desktop.qa.togglealignment`) verifies sidebar icon
  alignment, the tighter right inset with the inspector hidden and visible, and sidebar/inspector
  collapse and reopen.

- Windows/Linux runtime acceptance remains pending.

#### Highlight-color checks on Windows

- The complete frontend/build-helper suite passes on Windows (252 passed, 11 optional/platform
  checks skipped), together with changed-file formatting, localization, documentation checks and
  TypeScript/production build. Tests cover old settings, all six palettes in both color modes,
  custom-color persistence and provider reload, invalid colors, save failures and restoring
  defaults. The existing Vite WebSocket-port and production large-chunk warnings remain.

- An isolated Tauri/WebView2 host (`sh.uterm.desktop.qa.activeicons`) runs the real App with
  temporary settings and mocked desktop commands. Visual inspection verifies the appearance
  controls, default theme highlighting and applying a custom color to visible connection switches
  and the selected tool. The custom color survives an app restart, dark/light mode and a theme
  change; choosing Follow theme restores the selected palette's accent. No real server connections
  are used; macOS/Linux runtime acceptance of these controls remains pending.

### Sidebar action buttons

Sidebar section actions show only their icons at rest, revealing compact circular borders and
backgrounds on hover or keyboard focus without changing button size. Project/Worktree quick actions,
footer connection switches and Command/Settings/Agent controls use capsule groups with circular
buttons; project actions still appear on row hover or keyboard focus, and the footer wraps when
narrow.

The Settings close button uses the shared circular close icon, retaining its accessible name and
installation-time disabled state.

### Footer Add button

The footer's Add project or session button uses a bold plus with no circular frame or background,
including on hover. Its 34 px click target, action menu, tooltip and visible keyboard focus are
retained.

#### Footer Add checks

- Footer Add validation: the sidebar connection regression test, formatting, documentation checks,
  TypeScript/production build and an isolated macOS desktop build pass. Native QA
  (`sh.uterm.desktop.qa.footerplus`) verifies the unframed bold plus in dark mode, opening the Add
  menu and dismissing it with Escape.

- Light-mode and Windows/Linux runtime acceptance remain pending.

#### Hover-frame checks

- Hover-frame validation: 16 focused sidebar and bilingual UI tests, formatting, documentation
  checks, TypeScript/production build and an isolated macOS desktop build pass. Native preview
  (`sh.uterm.desktop.qa.hovercontrols`) confirms icon-only default controls and their alignment
  while resizing the sidebar.

- Pointer/focus transition acceptance and Windows/Linux runtime acceptance remain pending.

### File-list controls

The file list's New file, New folder and Refresh controls use compact 24 px circular buttons with 14
px icons and 4 px gaps. They have no persistent border/background; hover and keyboard focus remain
visible, and action tooltips and accessible names are retained.

#### Compact file-control checks

- Compact file controls validation: 15 focused file-refresh and bilingual UI tests, formatting,
  documentation checks, TypeScript/production build and an isolated macOS desktop build pass. Native
  QA (`sh.uterm.desktop.qa.compactfiles`) verifies the smaller controls in the dark file list,
  refresh interaction, hover and the visible keyboard focus ring.

- Windows/Linux runtime acceptance remains pending.

#### Rounded-control checks

- Rounded controls validation: 209 frontend/build-helper tests pass, with eight optional
  Java/database checks skipped. Formatting, localization, documentation checks,
  TypeScript/production build and an isolated macOS desktop build pass.

- Native QA (`sh.uterm.desktop.qa.roundtoolbar`) verifies the toolbar, sidebar section buttons,
  project quick-action capsule, footer groups and Settings close button in dark/light modes at the
  default 248 px sidebar width, plus the dark layout and footer wrapping at 176 px. It also verifies
  Files/Git/Working directory selection, keyboard activation and visible circular focus,
  hiding/reopening both panels, connection-switch states and closing Settings with Enter.

- Windows/Linux runtime acceptance remains pending.

### Inspector visibility in workbenches

Opening Database components from the sidebar temporarily hides the inspector together with its
layout column. Files, Git, GitHub and Working directory controls stay out of the sidebar footer;
returning to the project restores the selected tool and its left/right position.

Database and Redis workbenches also hide project inspectors.

#### Inspector visibility checks

- Inspector visibility validation: 192 frontend/build-helper tests pass, with eight optional
  Java/database or macOS-only checks skipped. Component coverage exercises all four local tools on
  both sides, absence of inspector requests while components are open, tool restoration and retained
  local sessions.

- An isolated Windows app (`sh.uterm.desktop.qa.dbtoolbar`) verifies opening components from Git at
  the default 248 px sidebar width, the footer remaining at the bottom without a stray Git
  toolbar/error area, and Git restoration on returning to the project. Narrow-sidebar and left-side
  native interaction, and macOS runtime acceptance of this layout remain pending.

- Locked dependency installation, localization/documentation checks, changed
  source/test/feature-guide formatting, both Cargo formatting checks, TypeScript/production build
  and the isolated Windows desktop build pass. The production build retains its large-chunk warning.

### Application context menus

Right-clicking the application page suppresses the browser's default menu, including Print, Save as
and More tools. Project, Worktree, session, file-tree and branch menus remain available.

Windows also disables WebView2's default menus for embedded frames, including isolated HTML
previews, without relaxing their sandbox.

#### Validation and limits

- Windows validation: 158 frontend/build-helper tests pass, with two platform-specific tests
  skipped; 40 backend tests, 16 local-service tests, locked dependency installation,
  TypeScript/production build, localization and documentation checks pass. Event tests cover blank
  space, inputs, dialogs and application handlers that stop propagation.

- Native Windows menu acceptance and macOS interaction (including isolated previews) remain
  unverified. The production build's large-chunk warning remains.

### Swapping the workspace and inspector

The Swap left and right panes button is centered vertically on the divider between the main
workspace and inspector. It stays hidden until the pointer hovers over the divider or the button;
moving away hides it again.

- Keyboard focus also reveals it. Clicking it exchanges the main workspace (terminal/editor,
  including its toolbar) and the inspector (Files, Git, GitHub or Working directory).

- The project sidebar stays in place. Widths follow their content, and the position is saved
  globally across projects and application restarts; resetting interface settings restores the
  inspector to the right.

- The button supports keyboard activation, and the command palette and shortcut settings expose the
  same action without a default binding. Swapping retains mounted terminal/editor instances, output,
  drafts, file-tree expansion and scroll state.

- It does not request a file save or close; existing editor autosave still applies. The inspector
  show/hide button follows the inspector side while remaining in the main title bar: it sits at the
  title bar’s left edge beside a left-side inspector and at the right edge for a right-side
  inspector.

- It never joins the inspector’s Files/Git action bar, and the left-side restore button keeps the
  same title-bar position while the inspector is hidden. The control is unavailable while the
  inspector is hidden or empty, Git diff is displayed in the central content area, a divider is
  being dragged or an editor transition is pending.

- Restoring the inspector or leaving expanded diff restores the chosen position. Settings-save
  failures remain visible and leave the layout unchanged.

- Separator dragging and Left/Right keys follow the displayed side; double-click or Enter restores
  the default width, and releasing at 30 px or less collapses the inspector toward its side of the
  working area. Inspector width remains a preference for the current run only.

### Drag-to-collapse and reopen hints

The sidebar and inspector dividers use the same thin, theme-colored highlight on hover or keyboard
focus, including when the inspector is on the left. Drag either divider to resize its panel.

The project sidebar and inspector highlight at a requested width of 30 px or less and collapse only
on pointer release. The inspector can occupy either side of the main workspace.

- Dragging back above the threshold while holding cancels the snap. The inspector checks this
  threshold before applying its minimum width, remembers the current panel and reopens through its
  button or shortcut.

- Release restores the pre-drag width for reopening; pointer cancellation clears the highlight
  without hiding. Window resizing alone does not trigger collapse.

- Both panel toggles use 18 px icons in 36 px circular buttons. After a drag is released at the
  collapse threshold, the corresponding reopen icon blinks for three seconds; reopening stops the
  hint immediately.

- Manual hiding, cancelled drags and dragging back outside the threshold do not trigger it. Each
  panel has its own hint timer; reduced-motion mode uses a steady three-second highlight.

#### Validation and limits

- Nine focused sidebar/inspector layout and pane-swap tests pass, together with repository
  formatting, documentation checks, TypeScript/production build and an isolated macOS desktop build.
  The production build retains its existing large-chunk warning.

- Native macOS QA (`sh.uterm.desktop.qa.panelhover`) verifies matching dark-theme divider
  highlights, inspector resizing on both sides, pane swapping, drag collapse and reopen hints with
  the previous width restored. Windows/Linux runtime acceptance of these divider styles remains
  pending.

### Panel keyboard shortcuts

Toggle left sidebar uses Ctrl+B on Windows and Cmd+B on macOS; toggle inspector uses Ctrl+Alt+B or
Cmd+Option+B. Both appear in Settings → Keyboard shortcuts and the command palette, and can be
rebound or disabled.

The inspector shortcut restores the last panel (falling back to Files when its project is
unavailable) and requires a working directory. Dialogs and pending editor transitions suppress these
shortcuts.

#### Validation and limits

- Automated tests cover defaults, conflicts and custom bindings; native terminal shortcut acceptance
  remains pending.

### Sidebar styles

Settings → Appearance → Sidebar style provides two preview cards. Classic sidebar is the default,
including for existing saved settings. Icon navigation sidebar places a vertical icon rail beside
the content list. Choosing a card applies and saves it immediately across workspaces and restarts; a
failed save displays an error and keeps the saved style. Restoring interface and terminal defaults
selects Classic sidebar.

- The navigation rail offers All, Projects and sessions, SSH connections, Redis connections and
  Database connections. All three connection categories, their lists and Add actions remain
  available even when their Classic sidebar switches are off. Switching styles preserves these saved
  switches; returning to Classic sidebar restores its original visibility choices.
- Selecting a category filters only the sidebar list, preserving the current project, session,
  workbench and connections. The current category is retained during this app run and starts at All
  after restart.
- In the navigation style, Hide sidebar, the sidebar shortcut and drag collapse hide only the
  content list. The 48 px icon rail stays visible with its category and footer buttons. Click a
  category or Show sidebar to restore the list at its previous width, or drag the rail's right edge
  to expand it. The Classic sidebar still hides completely.
- Add, Commands, Settings and Agent share the button group at the bottom of the rail. The Add menu
  starts with New terminal, followed by Add project and enabled Agent chats. Add SSH connection, Add
  Redis connection and Add database connection appear at the end of the menu. Both sidebar styles
  use this order. The navigation style has no connection switches or footer below the content list;
  the Classic sidebar retains its footer controls. Selected navigation icons use the configured Icon
  highlight color; both styles adapt to narrow sidebar widths.

#### Sidebar-style checks on Windows

- The complete Windows frontend/build-helper suite passes (273 passed, 11 optional/platform checks
  skipped), including five sidebar/App regressions. Coverage includes all three Classic switches
  being off, navigation categories and lists remaining available, style switching without changing
  saved choices, provider reload, context menus, SSH removal confirmation/cancellation, Add-menu
  order and welcome dialogs in both languages, and unchanged profiles/sessions/selection. Classic
  visibility combinations and the retained rail/collapse interactions also pass.
- Changed-file formatting, localization, documentation and TypeScript/production build pass.
- An isolated Tauri/WebView2 app (`sh.uterm.desktop.qa.sidebarstyles`) runs the real App with
  temporary profiles and mocked desktop commands. Native inspection verifies the two settings cards,
  switching to the navigation layout, project/SSH filtering, rail footer controls, Chinese dark and
  English light layouts, and the compact 176 px navigation layout. The rail Add button opens its
  complete menu and Escape returns visible focus to it. The content footer is absent, and the rail
  group remains accessible at 248 px and 88 px in light/dark appearance. Native Chinese/dark
  inspection also verifies button and drag collapse to a retained 48 px rail, category/drag
  restoration and the complete Add menu while the list is hidden. With all Classic connection
  switches off, native inspection confirms all three navigation icons, lists, welcome actions and
  Add items, database filtering and the retained hidden sections after returning to Classic.
- The UI fixture uses no real processes or server connections. Native acceptance of
  shortcut-triggered menu dismissal, expanded navigation below 88 px, restart persistence and
  macOS/Linux interaction remains pending. The production build retains its existing large-chunk
  warning.

### Workspace header and sidebar width

At normal widths, the sidebar header places the workspace name and hide button on one row,
vertically centered with the main toolbar and to the right of the window controls on macOS. There is
no separate uTerm/Local brand row.

- The workspace name appears as text without a field border or dropdown arrow. Clicking it opens a
  compact 180 px menu below the header, with smaller item padding; keyboard activation and menu
  navigation remain available.

- Long names are truncated in the header with their full name in a tooltip and wrap inside the menu.
  Drag its right edge to resize, with a minimum of 30 px in Classic or 48 px in navigation style.
  The maximum is the smaller of 320 px or 30% of the window (with a 180 px floor).

- Dragging to 30 px or less in Classic, or 78 px or less in navigation style, highlights it.
  Releasing hides Classic completely or keeps the navigation rail while hiding its list. The toolbar
  button reopens the list. Width is retained for the current app run.

- The separator also supports arrow keys, Home to hide, End for maximum width and Enter/double-click
  to reset.

- Narrow sidebars keep section headings on one line. Hovering or focusing a project/Worktree row
  floats its terminal/Agent capsule to the right when inline space is insufficient, retaining the
  original target and missing-folder restrictions. Escape, outside clicks, scrolling or resizing
  dismiss the floating capsule. The More actions menu remains a fallback when floating controls are
  unavailable.

- Very narrow sidebars stack header controls and use resource/session icons with full names in
  tooltips and accessible labels. Section actions wrap, and footer buttons wrap within their groups
  instead of being clipped. The footer scrolls when needed to leave room for the project list. SSH
  host search and its quick-connect button return when the sidebar is widened.

- Add and workspace menus open outside the sidebar with their normal readable widths, bounded by the
  window. Near the collapse threshold, content is hidden to avoid crushed controls. Widening
  restores the complete layout while preserving selection, sessions and connection settings.

#### Validation and limits

- On macOS, nine focused sidebar tests, TypeScript/production build, repository formatting and
  localization checks pass. Regression coverage includes floating placement, unchanged Agent targets
  and folding, resize dismissal and retained keyboard focus in wide rows.

- The isolated native app (`sh.uterm.desktop.qa.sidebaractions`) renders the real Sidebar with
  temporary state. Visual checks cover 176 px and 112 px navigation sidebars, Chinese/dark and
  English/light layouts, long names, project/Worktree Agent callbacks and Escape dismissal.

  Browser inspection also verifies the inline layout at 248 px in Classic and keyboard focus
  restoration. No real sessions or servers are used; Windows/Linux acceptance of floating controls
  remains unverified. The production build retains its large-chunk warning.

- On Windows, 23 focused sidebar, welcome and bilingual UI checks pass, together with changed-file
  formatting, localization/documentation checks and TypeScript/production build. Coverage includes
  project/Worktree quick-menu targets, enabled Agents, missing folders, Escape focus return,
  connection guards, visibility settings and collapse boundaries.

- An isolated Tauri/WebView2 app (`sh.uterm.desktop.qa.activeicons`) runs the real App with long
  names, temporary profiles and mocked desktop commands. Native pointer drags verify the compact 176
  px layout and the 88 px icon layout, single-line Chinese headings and fully visible footer
  controls. No real processes or servers are used. Native acceptance of the final popup placement,
  narrow light/English layouts on Windows and Linux interaction remains pending.

### Terminal resizing

Drag the project sidebar, inspector or session divider to adjust the central terminal area. The
terminal keeps its current character grid while the layout changes and fits after the size has
remained stable for 120 ms. Existing output is consumed before fitting. During a drag, the viewport
may clip the old grid or temporarily leave extra space until fitting finishes.

Sidebar and inspector drags follow the latest pointer position once per display frame and commit the
final width on release. Task output and activity indicators continue updating during the drag.
Collapse highlights, keyboard resizing and either inspector position retain the same controls.
Cancelling a drag clears the highlight without hiding the panel; a navigation sidebar returns to its
previous width and collapsed state.

The host processes one resize at a time and retains only the latest pending size. Replaying a
session keeps its saved dimensions until replay completes; closing or reconnecting drops pending
resizes for the old attachment. Resize errors remain visible in the session.

#### Panel-drag checks on macOS

- App regressions cover frame coalescing without session rerenders on pointer movement, task-state
  updates during a drag, the final release position, cancellation, unmount cleanup, collapse hints,
  navigation-rail reopening and either inspector position. A 60-move regression produces 60 extra
  session renders with the previous implementation and none during pointer movement with the current
  implementation; pointer-down, release and task-state changes still render normally.

- The frontend/build-helper suite passes (274 passed, ten optional/platform checks skipped), along
  with repository formatting, localization, TypeScript/production build, documentation checks,
  locked dependency installation, host/backend suites and desktop compilation. The isolated desktop
  build also passes. Vite's existing WebSocket-port and large-chunk warnings remain.

- The isolated native app (`sh.uterm.desktop.qa.paneldrag`) runs the real App and xterm views with
  45 fixture projects and six simulated terminal-output streams, redrawing 28 rows every 32 ms.
  Native pointer checks at 1200×760 cover sidebar resizing, inspectors on either side, collapse and
  reopening, navigation-rail expansion, Chinese/dark and English/light appearance, and aligned
  output after fitting. This verifies WebView interaction with simulated output, not live Agent
  tasks or SSH services. The updated drag preview still needs Windows and Linux runtime acceptance.

#### Resize checks on Windows

- All 51 focused terminal, sidebar/inspector layout and workspace tests pass, including seven resize
  regressions for continuous dragging, output consumption, replay, hidden/disposed terminals, slow
  hosts, failures and attachment cleanup. Changed-file formatting, localization and
  TypeScript/production build pass, together with an isolated desktop build.

- An isolated Windows Tauri/WebView2 app (`sh.uterm.desktop.qa.terminalresize`) runs real local
  sessions. Repeated project-sidebar and inspector drags with OpenCode 1.18.32 show aligned content
  during and after resizing, without model requests. A continuously redrawing Node terminal fixture
  verifies split-divider resizing and consecutive row markers in both panes, including a narrow
  eight-column pane. OpenCode emitted a Bun 1.3.14 segmentation-fault report during narrow split
  testing; acceptance of that OpenCode scenario remains incomplete.

- The complete frontend/build-helper suite passes (273 passed, 11 optional/platform checks skipped),
  including the pane-swap App regression. Vite's WebSocket-port and large-chunk warnings remain.
  Linux runtime acceptance remains pending; macOS panel-drag checks are described above.

### Error-banner timing

Central error banners hide after 1.5 seconds without clearing the underlying error state. A
different message starts a new timer; unchanged background errors do not keep reopening the banner.

Workspace-load retry remains available after the banner hides. Native timing acceptance remains
pending.

### Clicking outside dialogs

Settings, the command palette and the Agent dialog close when a primary pointer click starts and
ends outside their bounds. Internal clicks and drags starting inside do not dismiss them.

Settings cannot be dismissed during update installation.

#### Validation and limits

- Boundary tests cover inside/outside coordinates; native pointer interaction remains unverified.

### Language switching

Settings → General switches Simplified Chinese and English immediately, including open panels,
menus, command search, validation messages, accessible labels and editor search controls. Switching
language does not recreate terminal sessions or replace editor documents.

Application-owned backend diagnostics are localized at display time; unknown OS/provider output,
terminal content, filenames and user-entered names remain unchanged. Native operating-system dialog
controls follow the OS language; the project chooser title follows the app language.

### Translation diagnostics and checks

Missing message keys produce an explicit diagnostic marker and a deduplicated console error instead
of silently returning Chinese. `pnpm i18n:check` rejects unregistered Chinese source literals,
untranslated JSX text/accessibility attributes and invalid literal-key parameters.

Tests verify all registered translations and placeholder parity, negative checker fixtures, live
language subscriptions, all nine settings tabs and major panel rendering in both languages. Source
analysis and mocked component tests are regression gates, not proof of every dynamic or native
runtime state.

### Interface themes

Settings → Appearance → Interface theme offers Black (black and silver, the default), Sandstone
(warm charcoal and sand), Ocean (navy and ice blue), Moss (forest green and mint), Paper (warm white
and terracotta), and Clear Sky (cool white and sky blue), with preview cards. Paper and Clear Sky
always use light interface colors without changing terminal color-mode preferences.

- The other four support dark, light and system color modes. Selection applies immediately and saves
  automatically without changing terminal color selections or recreating sessions.

- Missing interface-theme settings default to Black; invalid values are rejected.

Workspace and section names, project entries, branch selectors, panel tabs and settings labels use
semibold text. Shared buttons and form controls also use heavier text, and navigation and toolbar
icons use thicker outlines. Secondary text has stronger contrast in both dark and light themes;
selected icons retain the configured Icon highlight color.

### Welcome page and connection actions

The interface uses warm charcoal surfaces, a restrained sand accent, fine dividers and compact
controls, with a matching light palette. Sidebar selection, terminal pane focus and inspector tabs
use consistent states.

- A welcome page offers project, terminal and chat actions with configured shortcut hints;
  unavailable actions are disabled. Below these actions, compact Add SSH connection, Add Redis
  connection and Add database connection buttons follow the sidebar and its + menu: all three are
  available in Icon navigation sidebar, while Classic sidebar uses the saved visibility switches.

- In Classic sidebar, hiding a connection section hides its welcome action; showing it restores the
  action, while folding the section keeps it available. Each button opens the existing connection
  dialog and remains disabled until the runtime and workspace are ready.

- The buttons reflow with the available width; short windows scroll without losing access to the
  heading or footer. Empty inspectors do not reserve screen space.

- UI colors and terminal ANSI colors are independent, and reduced-motion preferences are respected.
  See [DESIGN.md](../DESIGN.md) for tokens and design references.

#### Welcome-action checks on Windows

- Welcome connection-action validation on Windows: the focused App regression and four sidebar
  regressions pass. Changed-file formatting, localization, documentation checks and
  TypeScript/production build also pass.

- Coverage includes startup-disabled controls, all eight visibility combinations, preserved existing
  welcome actions, navigation actions with all Classic switches off, retained choices when switching
  styles, both languages and opening/cancelling each real connection dialog without changing
  profiles. An isolated native Tauri/WebView2 host (`sh.uterm.desktop.qa.sidebarmenus`) renders the
  real App with temporary workspace state and mocked desktop commands.

- It verifies footer/welcome/+ menu agreement, retained actions while folded, all three dialog
  targets in Chinese/English, cancellation, dark/light layouts, a three-button row with tools
  hidden, complete labels and scrolling at 680×500, and an accessible heading at 900×650. No real
  sessions or server connections are created.

- Live desktop-command integration and macOS/Linux runtime acceptance remain unverified. Vite
  WebSocket-port and production large-chunk warnings remain.

## Architecture

### Binary terminal output

Terminal output crosses the desktop-to-WebView boundary as binary frames with a small JSON metadata
header. The renderer passes a byte view of the received buffer to xterm without constructing a JSON
number array or copying the output again; consumption acknowledgements retain only metadata.

The desktop releases the source frame before waiting for acknowledgement. Session IDs, replay
dimensions/order, output backpressure, scrollback settings and the local host protocol are
preserved.

Malformed frames show a connection error and detach the affected view. Tauri may internally encode
small binary messages as JavaScript byte arrays; large frames use its binary IPC response path.

#### Binary-output checks

- Validation: 156 frontend/build-helper tests and 40 backend tests, formatting, localization,
  TypeScript/production build and an isolated macOS desktop build pass. Local-service tests pass on
  a full rerun; the initial run encountered intermittent host startup lock contention.

- Tests cover every byte value, empty output, metadata preservation, shared-buffer decoding and
  malformed headers. A 1 MiB sample cycling through all byte values occupies 3,743,840 bytes as the
  previous JSON frame and 1,048,667 bytes as a binary frame (about 72% less transport data); this is
  not a total application memory measurement.

- Native QA (`sh.uterm.desktop.qa.memory`) verifies 10,000 output lines through the completion
  marker, detach/relaunch replay, green ANSI text with Chinese/Unicode characters, exit code 7 and
  Close Session. Long-running memory reduction, real Agent traffic and Windows/Linux runtime
  acceptance remain unmeasured.

### On-demand editor and PDF resources

The file editor and its Markdown/syntax dependencies load on demand, with loading and failure
states. Unchanged Git branch polls preserve React state identity.

- PDF thumbnails render near the viewport and release offscreen canvas buffers. The development
  server streams local PDF resources instead of retaining all resource bytes in memory; production
  retains the complete PDF resources for offline compatibility.

- Key resource-lifetime decisions have English/Chinese comments.

### Git refresh, file search and replay

The Git panel issues one snapshot read when window focus or visibility returns. Selected
working/staged diffs refresh after that read succeeds, including when Git status is unchanged but
file contents have changed.

- Hidden-window polls skip reads; failures remain visible and keep the current diff available.
  Directory listings cache sort keys while retaining directories-first, case-insensitive name
  ordering and the original-name tie-breaker.

- Case-sensitive file search borrows paths and lines; LF-only content skips newline-copying, while
  CRLF/CR normalization, Unicode matching, line numbers, ignore rules and search limits remain
  intact. Terminal delta replay reserves one output buffer and copies whole retained chunks in
  order, preserving reset decisions, sequence numbers, empty output and exit metadata.

#### Refresh, search and replay checks

- Windows validation of these paths: 162 frontend/build-helper tests pass with two platform-specific
  skips, alongside 43 backend and 18 local-service tests. Five focused regressions cover
  focus/visibility request counts, unchanged-status diff refresh, hidden polls, failure recovery and
  cleanup, directory ordering, Unicode/case-sensitive search, mixed line endings, all byte values,
  replay order, exit metadata and expired/future cursors.

- Frozen dependency installation, TypeScript/production build, localization, documentation checks,
  changed-file formatting, both Cargo format checks and desktop compilation with isolated identifier
  `sh.uterm.desktop.qa.optimization` pass. The production build retains its large-chunk warning.

- Native focus/visibility interaction, whole-app CPU/RSS gains and macOS/Linux runtime acceptance
  remain unmeasured; the installed application was not restarted.

### Connection and component resources

Connection resource controls: Redis handshakes reserve slots without holding the connection-map
lock, leaving other connections usable and disconnectable. Both Redis and database eight-connection
limits include handshakes and release reservations on failure.

- Component downloads retain partial files for resuming after interruption or cancellation; offline
  imports and extraction use temporary files that are removed on failure/cancellation. Verification
  uses a 64 KiB buffer and extraction reads directly from files.

- Completion events refresh component status without rehashing drivers every second; closed
  component details and hidden disconnected workbenches do not load status. Database replies
  transfer ownership without a result clone, and editing SQL preserves unchanged result-cell
  renders.

- Disconnects release cached rows/metadata while preserving SQL drafts; hiding a connected workbench
  keeps its results. JSON serialization shares one output buffer; Redis hex previews decode at most
  258 bytes.

- The parent owns each database worker temporary directory and removes certificate files after
  disconnect or unexpected worker exit. One-use SSH password servers check idle state every 100 ms,
  wake immediately on disposal and stop after rejecting a fingerprint.

#### Connection-resource measurements

- Resource validation: five independent-process stress microbenchmarks on macOS ARM64/Java 26.0.2.1
  with `-Xmx192m`, 200×32 Chinese/control-character cells, 10 warmups and 40 serializations reduce
  median elapsed time from 621 ms to 103 ms and median peak process RSS from 153,124,864 to
  103,809,024 bytes. This synthetic stress sample compares serialization, not whole-app gains.

- In a five-second idle sample after connecting the isolated Release app to TLS MySQL, native-main
  CPU is approximately 0.39% with 45.6 MB RSS; JDBC CPU is approximately 0% with 21.4–21.5 MB RSS.
  The snapshot excludes WebView/session-service processes, and RSS depends on system paging.

- Each database worker retains a 192 MiB Java heap cap excluding native memory;
  long-running/multiple-connection process-tree peaks remain unmeasured.

### Idle control and PTY monitoring

Idle resource handling uses queue notifications for local control, with a 30 second wait deadline
instead of repeated empty reads. Waiting does not claim requests, so reloaded views can still
process them; expired queue entries are removed before reuse.

- Authentication, loopback binding, request expiry and reply handling remain in effect. Windows PTY
  exit monitoring blocks in the operating system, while Close Session terminates the job
  independently of the child wait lock.

- The output reader waits on a condition variable for exit, preserving output order and
  acknowledgement. Unix child monitoring retains its existing behavior.

### Update verification and log scanning

Ready updates retain a verified cache path rather than the complete payload in memory. Prehashed
Minisign signatures are checked in 64 KiB chunks; legacy signatures retain the compatible bounded
byte-verification fallback.

- Installation loads and rechecks the payload before the existing session/editor/database/Redis/SFTP
  guards and installer. A missing or invalidated cache returns to Download update; a bad signature
  discards the corrupt cache without installing or automatically retrying.

- Online Java archives are read directly from their verified cache, avoiding a complete archive
  staging copy; driver replacement and offline import retain staging and atomic installation. Agent
  log scans reuse line buffers and 64 KiB readers.

- Claude parsing ignores conversation content and stores four integer token counters per response
  ID; duplicate fields, fallback request IDs, seven-day filtering, deduplication and read/time
  limits retain their existing behavior.

#### Idle and verification resource checks

- Resource validation on Windows: 82 backend checks, six focused control checks and 24 local-session
  service checks pass. Real ConPTY checks cover a blocked exit waiter with independent Close
  Session, normal exit code 7 and output sequence/order.

- Renderer regression coverage verifies no control claim while waiting, one reply after
  notification, unchanged update confirmation/guards, and manual recovery after cache verification
  failure. Component checks verify direct cache reads, retained cached content, driver staging and
  offline temporary-file cleanup.

- A synthetic 64 MiB signed update is checked in six independent debug-test processes (three per
  method), with a 500 ms post-verification hold for sampling: median peak working set is 73,662,464
  bytes with whole-payload verification and 6,586,368 bytes with streaming verification (about 70.3
  and 6.3 MiB). This measures the verification process, not whole-app RSS or installation peaks; the
  installer still needs a complete byte buffer.

- A two-file, 6,000-row Claude sample with 2 KiB message bodies scanned five times takes 925 ms with
  the baseline parser and 936 ms with the reduced-allocation parser; this sample does not
  demonstrate a CPU-time improvement. Whole-app idle CPU, long-running process-tree memory and
  macOS/Linux runtime acceptance of these paths remain unmeasured.

### Source layout

React components live in `src/components/`; state and pure logic in `src/lib/`; Tauri commands in
`src-tauri/src/`; PTYs, replay and hooks in `crates/utermd-local/`. The backend and session service
use separate Cargo manifests and lockfiles.

## Validation and limits

### Windows automated checks

- Repository-wide `pnpm format:check` passes, including Prettier and both Cargo workspaces.
  `.gitattributes` keeps text files on LF and Windows `.cmd`/`.bat` files on CRLF. A fresh Windows
  checkout with `core.autocrlf=true` passes Prettier, preserves batch-file CRLF and leaves binary
  assets unchanged.

- `.editorconfig` aligns editor defaults with the formatters: UTF-8, LF, two-space indentation, four
  spaces for Rust/Java and CRLF for Windows batch files; Markdown keeps intentional trailing spaces.
  PR/branch CI and stable-release builds run the complete `pnpm format:check` on macOS and Windows
  after frozen dependency installation and before tests/desktop compilation.

- Windows validation passes the full formatting check, workflow/Markdown formatting and ten existing
  packaging/release-helper regressions. Workflow parsing verifies the unconditional check order and
  rustfmt installation; Prettier configuration resolution verifies LF source files and CRLF batch
  files.

- Automated validation on Windows passes the complete frontend/build-helper suite (273 passed, 11
  optional/platform checks skipped), 108 backend tests (nine optional checks ignored) and 38
  local-session service tests (two optional installed-CLI checks ignored). Frozen dependency
  installation, repository-wide formatting, localization, documentation and TypeScript/production
  build pass.

- Windows desktop compilation (`pnpm desktop:check`) also passes. Application, desktop
  configuration, Cargo manifest and lockfile versions agree; the versioned bilingual release body
  loads through `releaseNotes(tag)` and both production updater configurations use the stable
  platform feeds without a notes override.

- Native acceptance remains feature-specific as recorded above; build and CI results do not
  establish untested native interactions or live credential/server integration. Production builds
  retain the large-chunk warning.

### macOS automated checks

- Current validation on macOS: 258 frontend/build-helper tests and 108 backend tests pass, with ten
  optional frontend checks skipped and nine backend tests ignored. The complete local-session
  service suite passes.

- Frozen dependency installation, formatting, localization, documentation checks,
  TypeScript/production build and desktop compilation pass. The production build retains its
  large-chunk warning.

- Native acceptance and credential limitations remain as described for each feature; macOS
  compilation does not establish Windows/Linux runtime acceptance.

### Panel collapse hints

- Panel collapse hint validation: 143 frontend/build-helper tests pass, including three-second
  expiry, manual-hide exclusion, cancelled/reversed drags, either inspector position, independent
  timers, immediate reopen cancellation and repeat-trigger timing. Source formatting, localization,
  documentation checks, TypeScript/production build and isolated macOS desktop build pass.

- Native QA (`sh.uterm.desktop.qa.collapsehint`) verifies matching icon sizes, hints after dragging
  each panel closed, return to normal appearance and reopening both panels. Native reduced-motion
  and Windows acceptance remain pending.

### Sidebar header and workspace menu

- Sidebar header validation: 143 frontend/build-helper tests, formatting for the changed source
  files, localization, documentation checks, TypeScript/production build and the isolated macOS
  desktop build pass. Native QA (`sh.uterm.desktop.qa.compactheader`) verifies the compact header,
  workspace menu placement, switching workspaces, long-name truncation and sidebar hide/reopen.

- Additional native QA (`sh.uterm.desktop.qa.headeralign`) verifies vertical alignment with the main
  toolbar and the menu opening below the aligned header. The text-only workspace trigger and compact
  menu pass 16 targeted sidebar/localization tests, source formatting, TypeScript/production build
  and an isolated macOS desktop build.

- Native QA (`sh.uterm.desktop.qa.workspacetext`) verifies the text-only appearance, compact menu,
  click/Enter activation, arrow-key navigation and Escape dismissal with focus returned to the
  trigger. Windows runtime and narrow-sidebar menu acceptance remain pending.

### Divider-button interaction

- Divider button validation: all 143 frontend/build-helper tests, 39 backend tests, local-session
  service tests, formatting, localization, documentation checks, TypeScript/production build and
  macOS desktop build pass. Native QA (`sh.uterm.desktop.qa.dividerhover`) verifies default hiding,
  hover reveal at the vertical midpoint with the inspector on either side, clicking to swap, hiding
  after moving away, and following the divider after resizing.

- Native keyboard-focus and Windows acceptance remain pending.

### Active-tree coverage

- Active-tree validation: all 140 frontend/build-helper tests, formatting, localization,
  documentation checks, TypeScript/production build and the isolated macOS desktop build pass.
  Component coverage includes complete trees, pinned descendants without duplicates, workspace
  filtering and moves, section-specific folding, independent folder-state restoration, selection
  guards, removal protection and drag boundaries.

- Native QA (`sh.uterm.desktop.qa.activitytree`) verifies project migration into Active, root and
  Worktree terminal creation and selection, Worktree folding, disabled project removal, pinned
  projects remaining only in Active, long names at 248 and 176 pixel sidebar widths, retention with
  only a Worktree session, and returning to Pinned while hiding Active after the last session
  closes. Native drag ordering, save-conflict handling and Windows runtime behavior remain
  unverified.

- Existing large-chunk and Rust unused-code warnings remain.

### Pane-swap coverage

- Pane swap validation: 143 frontend/build-helper tests pass, including old-settings defaults,
  position round trips, custom shortcuts, persistence failure, retained terminal/editor nodes and
  drafts, file-tree expansion/scroll preservation, hidden/expanded inspector guards, reset and
  mirrored resizing. Formatting, localization, TypeScript/production build and an isolated macOS
  desktop build pass.

- Native QA (`sh.uterm.desktop.qa.paneswap`) verifies swapping with retained terminal output/focus
  and unsaved editor text/focus, width following content, resizing on both sides, left-side
  collapse/reopen, custom shortcut activation, Git expand/restore, light/dark layouts, a 700×520
  window with the project sidebar hidden, and position persistence after quitting and reopening the
  QA app. Component tests use terminal/editor rendering adapters; the native checks exercise the
  real renderers.

- Windows runtime acceptance remains pending. Existing bundle-size and Rust unused-code warnings
  remain.

### Project-menu coverage

- Project-menu validation on macOS: 139 frontend/build-helper tests, formatting, localization,
  TypeScript/production build and an isolated desktop build pass. Component tests cover path copying
  and failure reporting, bilingual labels, keyboard expansion/return, destination selection, empty
  destinations and edge positioning.

- Native QA (`sh.uterm.desktop.qa.projectmenu`) verifies the removed entries, submenu layout and
  Escape behavior, copying the exact project path and moving a test project into another workspace
  while retaining its files. Windows/Linux native menu interaction and long-list scrolling remain
  unverified.

### Branch-picker coverage

- Branch picker regression tests cover editor save conflicts, deferred actions after repository
  changes, repeated requests, stale polling, Local/Remote groups, remote switching, context actions,
  missing upstreams, visible remote/authentication failures and keyboard dismissal. Backend tests
  use temporary local/bare repositories for unfetched remote listings, partial remote failures,
  narrow clone tracking, name collisions, branch-switch conflict protection, upstream push/pull,
  divergent history and force-push prevention.

- Pull coverage includes retaining unrelated staged, unstaged and untracked files both when already
  up to date and during a fast-forward, and rejecting file overwrites even when automatic stash is
  enabled in Git configuration.

- On macOS, `pnpm test` passes 274 frontend/build-helper tests with ten skips; `pnpm test:backend`
  passes 113 tests with nine default-ignored service/benchmark tests. TypeScript/production build,
  repository formatting, localization, documentation metadata/index and feature-guide formatting
  checks pass. The generated `docs/README.md` retains a pre-existing Prettier formatting warning.

- Native QA (`sh.uterm.desktop.qa.remotebranches`) verified both menu layouts, selecting an
  unfetched remote branch from a single-branch clone, creating its tracking configuration, pushing a
  test commit to a local bare remote, pulling a newer remote commit with file-list refresh, and
  fetching a new remote reference without changing the current branch. Native Pull with local
  changes, Windows/Linux runtime and authenticated network remotes still require acceptance testing.

- Existing large-chunk and Rust dead-code warnings remain.

### Clipboard coverage

- Clipboard validation on macOS: 137 frontend/build-helper tests, frozen dependency installation,
  formatting, documentation and localization checks, TypeScript/production build and an isolated
  desktop debug build pass. Native QA with bundle ID `sh.uterm.desktop.qa.clipboard` shows Chinese
  text pasted directly into a shell without a WebKit “Paste” confirmation or `NotAllowedError`
  banner.

- The installed app was not restarted. Native copy, multiline paste and live Agent clipboard
  acceptance remain pending; Windows and Linux runtime behavior was not retested on macOS.

- Existing large-chunk and Rust dead-code warnings remain.

### File-copy coverage

- File-copy validation on Windows: 135 frontend tests, 32 backend tests, TypeScript, production
  build and localization checks pass. The browser preview uses mocked filesystem commands; native
  integration remains unverified.

- The production build retains its large-chunk warning.

### Lifecycle and sanitization coverage

- Lifecycle regression tests cover successful versus failed/unknown Agent exits, repeated close
  failures and duplicate close requests. Windows process tests verify that installer cleanup
  terminates both its parent and child processes using an isolated Job Object; Unix uses an isolated
  process group and still needs native acceptance.

- HTML sanitization tests reject SVG `xlink:href` navigation as well as ordinary links. No Agent
  package installation is performed by these tests.

### Agent-installation coverage

- Agent installation and lifecycle validation: 133 frontend tests, 31 backend tests, 15
  local-service tests, production build, formatting and localization checks pass. A browser preview
  verifies the OpenCode installation panel and confirmation command.

- Tests do not install packages on the user's machine; native download/install/launch and macOS
  acceptance remain pending. The build still reports chunks over 500 kB.

### Panel drag boundaries

- Snap eligibility tests cover entering and leaving the threshold during a drag. Browser checks
  confirm release-to-collapse on the left; held-pointer highlight/reversal and native right-panel
  interaction still require runtime acceptance.

- Both panel minimum widths equal the 30 px collapse threshold. Layout tests verify 31 px remains
  visible and 30 px arms collapse during dragging; a browser check verifies left-panel resizing
  through 50 px to collapse without content spilling into the main area.

- Native right-panel acceptance remains pending.

- Sidebar browser acceptance verifies the top-right hide button, the 320 px drag limit and automatic
  hiding below the collapse threshold. Native desktop and macOS pointer acceptance remain pending.

### HTML-preview coverage

- HTML preview validation: 122 frontend tests, production build and localization checks pass. A
  browser run of the real file editor verifies full-document styles and content.

- Native WebView acceptance is not covered by this preview.

### Performance measurements

- Performance validation: 119 frontend/build-helper tests, localization checks and the
  TypeScript/production build pass. The main JavaScript chunk measures 909.45 kB versus a 1,343.64
  kB baseline (approximately 32% smaller); this is startup chunk size, not total installer size.

- Total installer reduction and runtime CPU/RSS improvements have not been measured. Deferred-editor
  failure/recovery and offscreen PDF rendering still need desktop interaction checks; the >500 kB
  chunk warning remains.

### Localization coverage

- Localization validation on Windows: 119 frontend/build-helper tests, 29 backend tests and the
  TypeScript/production build pass. An isolated browser preview of the real settings components
  verifies English → Chinese → English without reload and the translated reset button.

- Component tests mock desktop APIs and terminal/PDF rendering; live native dialogs, tray
  interactions, authenticated provider states and macOS localization still require runtime
  acceptance. The running desktop app is not restarted for these checks.

### Theme coverage

- On macOS, 254 frontend/build-helper tests pass, with 10 optional/platform checks skipped. Coverage
  includes settings round-trips, invalid values, custom icon highlights and at least 7:1 secondary
  text contrast against the canvas, sidebar and surface in all six themes and both color modes.

- Repository formatting, localization/documentation checks, TypeScript/production build and an
  isolated desktop build pass. The production build retains its large-chunk warning.

- An isolated macOS Tauri app (`sh.uterm.desktop.qa.legibility`) runs the real App with temporary
  profiles and mocked desktop commands. Native inspection verifies Chinese dark and English light
  settings labels, navigation, reset and close buttons; heavier sidebar, toolbar and Git icons; and
  branch labels.

  Native inspection also covers Black, Paper and Clear Sky theme switching and readable
  Classic/navigation sidebars at 248 and 176 px. An existing browser check covers Ocean selection,
  Moss light rendering and persistence after reload.

- No real sessions or server connections are used. Native Windows/Linux inspection, the other
  themes' desktop appearance and custom interface fonts remain unverified.

### macOS integration scope

- Current macOS validation: frozen dependency installation, all 187 frontend/build-helper tests, 56
  standard backend tests plus four explicitly executed real Redis integration tests, 32
  local-session service tests, formatting, documentation/localization checks, TypeScript/production
  build, desktop compilation and an isolated ARM64 app build pass. Native feature-specific
  acceptance remains as recorded above; Windows/Linux runtime acceptance is not inferred from these
  macOS checks.

### Target-system checks

Automated checks cover state validation, session identity and layout, file recovery, input handling,
build helpers, Rust backend and local service behavior. Run the commands in the README on the target
OS.

### Windows integration scope

- Current Windows verification: frozen dependency installation, documentation/localization checks,
  163 frontend/build-helper tests (two platform-specific tests skipped), 18 local-service tests, 48
  backend tests, six release-helper tests and the TypeScript/frontend production build pass. The
  full frontend suite passes with test-file concurrency limited to four; the initial parallel run
  encountered Vite SSR loading timeouts.

- Backend tests and desktop compilation with the isolated identifier
  `sh.uterm.desktop.qa.release014` pass with single-job compilation, without restarting the
  installed app. Frontend, desktop configuration, Cargo manifest and lockfile versions agree; the
  versioned bilingual release body loads through `releaseNotes(tag)` and agrees with the
  Windows/macOS updater configuration without an override.

- Changed version files and both Cargo formatting checks pass. Native mouse, localization,
  signed-update and installer acceptance remain as recorded for each feature; build results do not
  establish runtime acceptance.

- Shortcut tests cover selection-dependent copying, Control interrupt passthrough, paste keys, macOS
  modifiers and composition/AltGr exclusion. Clipboard shortcuts in live Claude/Codex sessions still
  require interactive verification.

- The frontend build reports a bundle-size warning for chunks above 500 kB.

### Visual acceptance and platform limits

- The Windows app was built and visually inspected in a separate design-QA window. Browser checks
  cover the welcome page at 680×500 without overflow and light-palette rendering.

- Full keyboard, split-pane, file/editor/dialog and macOS visual acceptance remains unverified.

- Interactive Windows/macOS acceptance, installer execution, credential-dependent GitHub/provider
  calls and signed updates require separate runtime checks. Browser preview does not exercise
  desktop commands.

- Unix-only PTY tests do not run on Windows.

### Documentation checks

Documentation metadata, the generated index, Markdown formatting, heading structure and local
navigation links pass their checks. These checks validate documentation only and do not change the
runtime acceptance recorded for each feature.

## Database connections and optional components

### Database setup and visibility

The workspace's Databases section supports MySQL, PostgreSQL, Oracle service-name, Elasticsearch and
MongoDB connections. SQL databases open the SQL workbench; Elasticsearch and MongoDB open the
document workbench. Add a profile with the section's plus button, select it and click Connect.

- The footer database icon independently shows/hides the section, retaining its connections, SQL and
  transactions. Connected, busy or dirty profiles cannot be edited or removed; referenced SSH
  profiles and workspaces are protected.

- Opening Database components from the sidebar temporarily hides the project inspector and returning
  restores its selected tool and position.

### Database credentials

Profiles retain endpoint, database/service, username, verified TLS/PEM CA, optional system OpenSSH
target and opaque credential reference. Passwords remain in memory unless Remember password stores
them in macOS Keychain or Windows Credential Manager.

- Credentials bind to the configured endpoint, TLS trust and resolved SSH identity; changing those
  requires reentry. Secrets pass through worker stdin, never process arguments or diagnostics.

- Workspace schema 7 retains a backup when upgrading older data; older apps reject it rather than
  silently dropping database profiles.

### Java and driver components

The SQL and MongoDB connection engine is bundled (35,462 bytes); its checked-in source, checksum and
JAR are verified together. Connection restores missing or modified versioned cache copies
atomically.

- Main builds need no JDK. Java and vendor drivers remain optional and excluded from installers.

- The app validates an explicitly selected Java first, then detects working Java 17+ from JAVA_HOME,
  PATH and platform locations, then uses a managed runtime. Component management is available in
  Settings, the sidebar section and connection dialog; an unavailable component never replaces the
  SQL editor.

- Install required components displays the missing download size and installs only selected
  dependencies. No automatic downloads or system Java changes occur.

- Online/offline installation requires catalog versions, exact sizes and SHA-256; the portable
  Temurin 21 runtime uses TUNA mirror packages. Archive extraction bounds paths, size and file
  count.

- Interrupted/cancelled downloads retain their prefix across restarts; Resume uses validated HTTP
  Range or restarts when unsupported. Verified complete packages are retained for installation
  retries; every reuse checks catalog size and SHA-256, online runtime archives are verified and
  extracted directly from the retained cache, while offline imports and driver replacement use
  separate temporary staging.

- Transient network/server failures allow at most three download attempts; cancellation,
  certificate, storage, missing-file and verification failures do not loop. Rate limits and server
  Retry-After guidance return a retry-later error.

- Each component offers Download manually beside Offline installation. Complete and partial caches
  use the same bounded cleanup policy as update caches.

- Uninstall retains profiles and is disabled while a database connection is open.

### Database TLS and SSH

Direct TCP, verified TLS and existing OpenSSH profiles are supported. Tunnels use a
destination-restricted loopback SOCKS proxy with a one-time authentication token; JDBC retains the
original hostname for certificate verification.

- TLS uses the selected Java trust store or provided PEM CA without disabling hostname checks.
  MySQL/PostgreSQL use official JDBC drivers; Oracle uses JDBC Thin service names.

- SID, Wallet/cloud presets, arbitrary JDBC URLs, custom driver imports and server installation are
  unavailable.

### Elasticsearch and MongoDB document workbench

Add a connection from Databases and choose Elasticsearch or MongoDB. Elasticsearch defaults to port
9200 and accepts username/password or an encoded API Key. MongoDB defaults to port 27017 with a
separate authentication database, defaulting to `admin`. Leave credentials empty for services that
permit anonymous access.

- Elasticsearch reuses the built-in HTTP client without Java or driver downloads. Install MongoDB's
  pinned Sync, Core and BSON drivers on demand through Database components: 2,779,903 bytes in
  total. These drivers and the optional Java runtime stay outside the main installer.

- MongoDB uses one host and port with `directConnection=true`. Standalone servers and directly
  reachable replica-set members are supported; SRV, multiple-host discovery, sharded routing
  configuration and arbitrary connection URIs are unavailable. SQL transactions, grid editing and
  execution plans do not apply to document connections.

#### Browse and query documents

1. Connect and select a database and collection, or specify one Elasticsearch index. Refresh objects
   loads at most 500 names; you can also enter an authorized name directly.
2. Enter an Elasticsearch Query DSL body such as `{"query":{"match_all":{}}}` and inspect index
   Mapping. For MongoDB, enter `{"filter":{},"sort":{"_id":1}}` with an optional `projection`, or
   use `{"pipeline":[{"$match":{}}]}` for read-only aggregation.
3. Click Run query or press Ctrl/Cmd+Enter. Each page contains at most 50 documents within the first
   10,000 results. Pagination reissues the query without a snapshot. After editing a query, run it
   again from the first page before using pagination. Elasticsearch pagination fields including
   `from`, `size` and `search_after` are managed by the workbench and cannot be supplied in the
   query.

MongoDB uses canonical Extended JSON to preserve ObjectId, dates and numeric types. Queries, edits
and exports retain JSON text without frontend number reserialization. Aggregation rejects `$out`,
`$merge` and server JavaScript operations, including nested pipelines. Elasticsearch preserves large
integers; source-filtered documents cannot be replaced or deleted.

- Queries and individual documents are limited to 262,144 characters, page documents to about 1 MiB,
  Elasticsearch documents plus additional metadata to 2 MiB, and transport to 8 MiB. Excess results
  fail explicitly instead of allowing edits to truncated documents. Server query budgets are 30
  seconds; Cancel query and disconnect closes the connection and retains drafts.

- Save JSON saves the current query; Export page JSON exports only loaded documents. Query and
  document drafts stay in memory. Hidden workbenches retain connections and drafts; switching
  targets or documents requires confirmation before discarding unsaved document changes. Exit guards
  cover both draft types.

#### Document writes and connection protection

Connections start read-only. Enable editing to create documents or replace/delete a selected query
result; each write requires confirmation. Writes take effect immediately without commit, rollback or
automatic retries. MongoDB account permissions and Elasticsearch server permissions still apply.

- Replacement and deletion check for conflicts. Elasticsearch sends the original sequence number and
  primary term; MongoDB matches `_id` and the entire original document with BSON types preserved.
  Changed documents, incomplete projections or transformed aggregation results can fail the check,
  retaining drafts for review. MongoDB replacement cannot change `_id`.

- TLS verifies certificates and hostnames, with optional PEM CA files. Both reuse the authenticated
  loopback-only SSH SOCKS channel, restricted to the configured endpoint; MongoDB does not discover
  additional nodes. Passwords and API Keys can use the existing system credential store, bound to
  endpoint, authentication method/database, TLS trust and SSH identity.

- Timeouts or lost connections can leave write results unknown. Reconnect and check server state
  before trying again. Fixed diagnostic codes avoid echoing documents or credentials from vendor
  errors. Connections and handshakes share the existing eight database slots; document connections
  do not create SQL browsing workers.

Protocol references:
[Elasticsearch Search API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-search),
[MongoDB Extended JSON](https://www.mongodb.com/docs/drivers/java/sync/current/data-formats/document-data-format-extended-json/)
and [MongoDB SOCKS5](https://www.mongodb.com/docs/drivers/java/sync/current/security/socks/).

### Object browsing and menus

Expand catalogs/schemas to load tables and views; system objects are folded. Object filtering
searches loaded names.

- Double-click, Enter or View data opens the current table's Data/Structure views without replacing
  SQL. Object menus open beside their table's action button, stay within the window and open upward
  near the bottom, outside the scrolling tree's clipping area.

- View data, View structure and Generate SELECT remain available for tables at the bottom of a long
  list. Only one object menu opens at a time.

- Outside pointer input, Escape, scrolling the tree, resizing, losing window focus or hiding the
  browser/workbench closes it; Escape returns focus to its trigger. Arrow keys and Home/End navigate
  the actions.

- Generate SELECT quotes actual names and confirms replacing an unsaved draft. Metadata treats `%`
  and `_` literally.

- Eight loaded namespace groups are cached per workbench, with up to 500 metadata rows per request.

### SQL tabs and execution scope

Up to eight SQL query tabs retain separate drafts, undo, selections and results during this run. All
tabs explicitly share one connection and transaction.

- Execute SQL runs the selection or caret statement by default; the scope selector also offers
  current/selection/all. Ctrl/Cmd+Enter uses automatic scope; Ctrl/Cmd+Shift+Enter runs all.

- Batches contain at most 100 statements, execute sequentially and stop on the first failure.
  Statement boundaries understand MySQL strings/comments, PostgreSQL dollar quotes/nested comments
  and Oracle alternative quotes.

- DELIMITER scripts and Oracle procedural blocks are rejected rather than split incorrectly.
  Commented SELECT and nonwriting WITH queries work read-only; mutating CTEs, locks and ambiguous
  MySQL backslash-quote strings require editing.

- Server account permissions remain authoritative.

### Completion, formatting and SQL drafts

Completion uses the selected dialect and loaded object/column names. Formatting changes whitespace,
retains identifier case, literals, comments and compound operators, and has its own undo step.

- Format a selection or the entire draft. Numeric server error positions/lines support Jump to
  failed statement; otherwise it jumps to that statement's start.

- Vendor error messages and SQL values are not returned in diagnostics. History retains the latest
  50 attempts within 262,144 SQL characters in memory; restore confirms replacing an unsaved draft,
  and Clear removes history.

- Restart recovery is unavailable. Each SQL draft is limited to 262,144 characters; each tab retains
  up to four recent result sets within a two-million-cell-character cache budget.

- Disconnection clears results, while SQL drafts remain. Copy SQL and Discard SQL changes are flat
  toolbar buttons; copy retains draft protection and discard requires confirmation.

- Save SQL clears that draft's guard only after the selected file is written.

### Result-grid layout and filtering

Hide/resize the object browser and resize the editor/result split with pointer or focused arrow
keys. Toolbars scroll horizontally on narrow windows and pagination stays at the bottom.

- Column headers and row numbers stay fixed while scrolling, with opaque backgrounds covering the
  cells beneath them. When columns exceed the result viewport, a visible horizontal scrollbar at its
  bottom lets you drag to additional columns without scrolling to the last row.

- The grid renders visible rows and columns rather than a complete wide table. Drag/Shift-arrow
  selection, row selection, Ctrl/Cmd+A/C, TSV copying with optional headers and adjustable column
  widths are supported.

- Double-click/Enter inspects the complete loaded value as literal text. NULL differs from empty
  text; truncated values are never fetched in full.

- Filter loaded page searches only the current result, including draft overlays. Server-side
  filtering instead issues a prepared table query; equality, comparison, literal substring and NULL
  conditions apply before paging.

- Pages use primary-key order when available and rerun the query; they do not hold a snapshot or
  count the entire table.

### Read-only workers and cancellation

Connections start read-only. In this mode browsing reuses the existing worker and rolls back reads;
enabling editing opens an independent read-only browser worker only when needed, so browsing never
settles SQL writes.

- Turning editing off releases that auxiliary worker. Disconnect closes both.

- The eight-worker limit includes owners, auxiliary browser workers and opening connections: eight
  read-only workbenches or four using both workers fill it. Browser-worker failure preserves the SQL
  connection and transaction; retry opens a fresh browser worker.

- SQL reply timeout/confirmed loss closes the connection and retains drafts. Queries have a
  30-second server timeout and a 40-second reply deadline.

- Cancel query deliberately closes the connection; connection-preserving driver cancellation remains
  deferred because write outcomes must stay explicit. Uncertain writes are never retried
  automatically.

### Editing tables and transactions

Enable editing to execute other SQL after confirmation. Commit and Roll back explicitly settle the
shared transaction; DDL may commit automatically.

- The pending indicator is conservative, including SELECT in editing mode. Editable table grids
  require an ordinary table, non-null primary key, supported scalar columns and transaction support
  (InnoDB for MySQL).

- Views, missing primary keys, BLOB/CLOB/vendor-specific columns and nontransactional tables stay
  read-only; arbitrary SQL query results are also read-only. Primary keys/generated columns cannot
  be updated; generated insert values are omitted.

- Double-click a writable cell or use Edit cell, distinguish NULL from text, then Stage cell change.
  Add row and Delete/Restore current row create drafts.

- At most 100 row changes and 768 KiB of draft payload are retained; values are limited to 16,384
  characters. Rows with truncated values cannot be edited or deleted.

### Applying drafts and recovering failures

Preview table changes shows generated SQL with placeholders and bound parameters. Apply to
transaction locks rows by primary key and compares original scalar values; stale/deleted rows or
changed table metadata fail visibly.

- A failure rolls back this batch's savepoint, retaining drafts and earlier SQL writes. The batch
  has a 25-second execution budget before its bounded refresh.

- Successful apply displays the current transaction's data and still requires Commit; Roll back
  restores committed data. Refresh, server filtering, export and paging cannot replace unapplied
  table drafts; switching tables, disconnecting or discarding requires confirmation.

- Unexpected connection loss retains the table snapshot and drafts for inspection, but requires
  reconnecting and checking server state before reuse. Quit/update guards cover all SQL and table
  drafts, active work and transactions, revealing hidden workbenches that require action.

### Export and execution plans

Export CSV/JSON writes only the loaded page through a native save dialog, with an 8 MiB output limit
and atomic save. CSV uses UTF-8 BOM, quoted fields, `\N` for NULL and spreadsheet-formula
protection; JSON preserves column descriptors, precision strings, NULL, binary and truncation
markers.

- Export excludes unapplied grid drafts and does not query all rows. Execution plan explains one
  selected/current read query without ANALYZE.

- MySQL uses EXPLAIN and PostgreSQL uses EXPLAIN (FORMAT JSON). Oracle requires editing plus
  PLAN_TABLE/DBMS_XPLAN permissions; it uses a savepoint to remove plan rows without settling
  earlier writes.

- PostgreSQL/Oracle live acceptance remains pending.

### Result and memory limits

Result limits: 256 columns, 200 rows per page, offset at most 10,000, 16,384 text characters or
4,096 binary bytes per cell, 1,048,576 serialized-cell characters and 8 MiB transport. Numerics
remain strings and binary is Base64.

- Each JVM has a 192 MiB heap cap; drivers may buffer data internally, so these result limits are
  not process RSS guarantees. History, drafts and result caches stay in memory unless explicitly
  saved/exported.

- Development JDKs, Cargo targets, test databases and node_modules never enter installers.

### Database validation

#### Document database checks on Windows

- The ordinary `pnpm test` suite passes with 241 tests and 11 opt-in/platform skips. A separate run
  enabling the MongoDB driver wire fixture passes both document-database tests. The final 19 focused
  frontend checks pass, including query-change pagination protection and retained drafts. Backend
  validation passes with 104 tests and six opt-in skips; the local-session service passes 26 tests.

- Focused checks cover exact JSON/BSON numbers, ObjectId, NULL, nested aggregation write guards,
  default read-only access, explicit write confirmation, original-document conflicts, encoded
  Elasticsearch document IDs, sequence/primary-term conditions, projection protection and bounded
  pagination and disconnecting an in-flight Elasticsearch request. The MongoDB fixture uses the real
  pinned Java driver against a disposable loopback protocol server; it does not connect to an
  existing database.

- Frozen dependency installation, TypeScript/production build, bundled-engine verification and
  `pnpm desktop:check` pass. Database source formatting and the global localization check pass.
  Documentation metadata/index and changed Markdown formatting pass. Production builds retain the
  existing large-chunk warning.

- Isolated Windows applications (`sh.uterm.desktop.qa.documents` and `.documents.narrow`) use the
  real workbench with simulated replies to inspect Elasticsearch and MongoDB queries, 40 object
  names, 50-document pages, immediate-write confirmation, Chinese/English switching and light/dark
  appearances. The 1,000-pixel window and the 640-pixel narrow window keep query and pagination
  controls usable; the narrow layout retains the pagination bar while results scroll.

- These fixtures do not establish acceptance against live Elasticsearch/MongoDB deployments,
  authenticated TLS/SSH servers or native credential/export dialogs. macOS/Linux runtime acceptance
  remains pending. The installed application and existing database services were not restarted.
  Java, MongoDB drivers and database servers remain outside the main installer; an isolated final
  installer-size comparison has not been measured.

#### Grid-scrolling checks on macOS

- Grid scrolling validation on macOS: 209 frontend/build-helper tests pass, with eight optional
  checks skipped. The isolated native app (`sh.uterm.desktop.qa.dbgrid`) uses simulated 256-column,
  200-row results to verify fixed opaque headers and row numbers, visible draggable bottom
  horizontal scrollbars, access to the final column and retained pagination at 900×600 and 640×420.

- Both light and dark appearances are inspected after scrolling. Formatting, localization,
  TypeScript/production build and isolated desktop builds pass; production builds retain the
  existing large-chunk warning.

- This validates the WebView layout rather than a live database connection. Windows/Linux runtime
  acceptance of this scrolling layout remains pending.

#### Object-menu checks on macOS

- Object-menu validation on macOS: 209 frontend/build-helper tests pass, with eight optional checks
  skipped. A focused 40-table regression covers bottom/right edge positioning, all three actions on
  the final table, one open menu, keyboard focus/navigation, scroll/resize/blur dismissal and
  cleanup when hidden, disabled, collapsed or unmounted.

- Formatting, localization, TypeScript/production build and the isolated macOS QA application build
  pass. Native QA (`sh.uterm.desktop.qa.dbmenufix`) at 900×600 verifies the menu opening upward on
  the final table of a 39-table list and all three actions targeting `user_roles`, using the real
  workbench with simulated database replies.

- This validates WebView interaction, not a live database connection. Production builds retain the
  existing large-chunk warning.

- Windows/Linux runtime acceptance of menu positioning remains pending.

#### Database automated checks on Windows

- Validation on Windows: 200 frontend/build-helper tests pass and ten opt-in/platform checks skip;
  69 backend tests and 22 local-session service tests pass, with four opt-in Redis tests ignored.
  Focused regressions cover SQL dialect boundaries/read-only guards, formatting (including Unicode
  prefixes, variables and compound operators), NULL/precision/CSV safety, draft coalescing, bounded
  wide-grid rendering and keyboard navigation, menu dismissal, retained SQL/results and transaction
  guards.

- An explicitly enabled write suite passes using uniquely named tables in a disposable loopback
  MySQL 5.7.33 schema on port 33379. It verifies bound Unicode/quoted values, preview, observer
  isolation, commit/rollback, duplicate-key batch rollback preserving earlier SQL, stale-row
  rejection, literal filters, insertion/deletion, read-only table restrictions and EXPLAIN.

- Java probes verify independent SQL guards and allocation-free JSON length accounting; real
  read-only MySQL checks pass directly and through authenticated SOCKS.

#### Database native checks on Windows

- The isolated native Windows app (`sh.uterm.desktop.qa.dbmenus`, local Java 21) verifies batch
  execution shortcuts without modifying SQL, query/result retention across tabs, formatting undo,
  in-memory history, loaded-table completion, outside-click/Escape menu dismissal and focus, staged
  cell editing, parameter previews, apply and rollback. Table viewports at 1280×800, 900×600 and
  640×420 keep the result footer visible.

- Turning editing off removes the auxiliary Java worker (two workers become one). An idle two-second
  snapshot records no CPU increase for the app/Java workers: the app main process is about 47 MiB
  RSS and Java workers about 66–68 MiB each; these exclude WebView subprocesses and do not establish
  peaks.

- Frozen installation, TypeScript/production build, pinned-JDK engine verification, isolated desktop
  build, changed-source formatting, localization and documentation checks pass. Production builds
  retain the existing large-chunk warning.

- New native export-save dialogs, macOS UI, PostgreSQL/Oracle live servers and complete database
  SSH/TLS acceptance remain unverified; authenticated SOCKS does not establish full SSH acceptance.
  The installed app/database service was not restarted.
