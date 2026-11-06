---
title: uTerm development guide
status: active
type: reference
created: 2026-10-17
updated: 2026-11-06
---

# uTerm development guide

[简体中文](development.zh-CN.md) · [Download and quick start](../README.md)

Build, validate and package uTerm from this repository. For feature usage and current acceptance,
see the [feature guide](features.md).

**Contents**

- [Development](#development)
- [Database component development](#database-component-development)
- [Installer maintenance](#installer-maintenance)
- [Project website](#project-website)
- [Validation](#validation)
- [Packaging and releases](#packaging-and-releases)
- [Repository](#repository)

## Development

### Shared core and native QA

`crates/uterm-core` contains UI-independent state validation and canonical storage.
`crates/uterm-ffi` exposes C ABI 1; manifests and lockfiles remain independent from the desktop and
host. Run `pnpm test:core`, `pnpm contracts:generate` and `pnpm contracts:check` after DTO changes.
Generated boundary types are committed; intermediate JSON schemas are not.

Shared Java task/configuration checks require an existing JDK 21 with `JAVA_HOME` set and its `bin`
on `PATH`. They compile a disposable JAR and use the isolated host; setting `UTERM_JAVA_CORE_REPORT`
writes a structured source/platform/behavior report. CI uploads it as `java-live-core.json`.
Building the application does not require or bundle Java.

The optional Maven workflow fixture additionally needs Maven 3.9.9 (`UTERM_MAVEN_HOME`) and network
access or a populated `UTERM_MAVEN_REPOSITORY`. Run the ignored
`real_maven_reactor_and_spring_boot_use_shared_task_lifetimes` host test explicitly as documented in
the README. `UTERM_MAVEN_CORE_REPORT` writes the detailed eight-scenario report. The dedicated Maven
CI runs actual Windows JDK8/11/17/21 and macOS ARM/Intel JDK21 processes without masking the
separate JDK8 Unicode launcher failure. This fixture does not establish GUI or manual acceptance.

On macOS 14 or newer, `bash scripts/macos-native-build.sh` builds the ad-hoc-signed QA app and
`bash scripts/macos-native-test.sh` runs Swift bridge tests against the Rust static library.
`bash scripts/macos-native-smoke.sh` requires a graphical login and WindowServer and records actual
window/exit evidence. CI retains native ARM/Intel artifacts and old Tauri checks. The QA identity is
`sh.uterm.desktop.qa.native`; never substitute the production identifier or attach its host. See
[migration status](native-migration.md) for acceptance gaps and source-bound evidence.

Source-bound desktop checks run on the existing Draft PR rather than publishing a release:

- `python3 -B scripts/client-performance-database.py` owns PostgreSQL and runs three sequential
  native/Tauri repetitions on a Mac; use `python` on Windows for its separate Tauri baseline.
  Version4 requires the real 120×30 grid, unchanged 14pt text and the full shared workload, with
  120/120/600-second idle samples. Run `node scripts/client-performance-report.mjs` afterward.
- `python3 -B scripts/client-upgrade-smoke.py`, after the native QA build, rebuilds pinned
  `uTerm-v0.2.4` source with a recorded private QA overlay. It downloads a signed private native
  ZIP, tests interrupted program replacement, actual UI crashes/recovery and explicit old-program
  plus latest-compatible-data rollback. This is not the unmodified published installer or a
  production cross-client updater. Original readers and services stay unchanged; initial legacy
  draft input, credential/hook references and OS boundaries remain labelled fixtures.
- `python3 -B scripts/migration-readiness.py --head SOURCE_SHA` needs GitHub read authentication. It
  audits actual task, PR, protected-branch and current-source artifact status into
  `ci-evidence/readiness/migration-readiness.json`. Missing or failed evidence makes it exit
  nonzero; that result does not merge, publish or alter production feeds.

The Client upgrade and rollback and Client performance evidence workflows archive actual app
reports, original owned-window images, toolchains and exact head/tested merge SHAs. Simulations and
user-waived human steps remain distinct from automated native actions. Task #42 and signed updater
#45 acceptance is documented at sourceec1a49d; #43/#46 and final #47 remain open for their new
results. The full Linux frontend regression at sourcec24d81a passes 429 tests with 11 explicit
skips.

Agent settings can install OpenCode, Claude, Codex, Gemini, Pi, MiniMax, Qwen Code, Copilot CLI and
iFlow CLI after confirmation using the local Node.js/npm installation. This requires internet access
and permission to write npm's global prefix. Hermes uses its official platform installation script.

Agent packages are optional and are not bundled with uTerm; other programs can be installed manually
and configured by executable path.

Launch at login uses the Rust dependency `tauri-plugin-autostart` and can be toggled in Settings →
General. No additional JavaScript dependency is required.

Requirements: Node.js 22.13 or newer, pnpm 11.22.0, Rust stable and Git. Windows requires the MSVC
toolchain, Visual Studio C++ Build Tools, Windows SDK and WebView2. macOS requires Xcode
command-line tools.

```sh
pnpm install --frozen-lockfile
pnpm uterm:dev
```

`pnpm dev` starts a browser-only frontend preview; desktop file, process and OS integrations require
the Tauri app.

### Editing and formatting

Use an editor with EditorConfig support. `.editorconfig` sets UTF-8, LF and two-space indentation;
Rust and Java use four spaces, Windows `.cmd`/`.bat` files use CRLF, and Markdown retains
intentional trailing spaces. `.gitattributes` applies the same line endings when Git checks out
files.

Configure format on save with the project's Prettier for frontend files and rustfmt for Rust. Before
committing, run `pnpm format` to apply the repository's formatters, then `pnpm format:check` to
verify them. The check covers frontend source, tests, scripts, website files, root
JSON/TypeScript/HTML, desktop JSON configuration and Rust sources under both Cargo manifests. Format
changed Markdown separately as described in the [documentation writing rules](writing-rules.md).

Both the PR/branch workflow and stable-release builds run `pnpm format:check` after frozen
dependency installation on their macOS and Windows jobs. Formatting errors fail the job before tests
and desktop compilation.

### CI dependency caches

The PR/branch and stable-release workflows cache the pnpm store and both Cargo target directories
without skipping any existing checks. Cargo dependencies are separated by runner image, architecture
and compiler/build inputs; pnpm dependencies are keyed by OS, architecture, pnpm major version and
the lockfile.

`.github/workflows/uterm-cache.yml` prewarms debug/test and release dependencies from `release` on
all three release platforms after `main` is pushed. To prewarm manually, open Actions → uTerm build
cache → Run workflow and select `main`. The workflow uses read-only repository permissions, runs no
tests, creates no installers and needs no signing secrets.

It consumes additional runner time so subsequent version tags can restore default-branch caches
despite GitHub's tag isolation. See the [feature guide](features.md#build-dependency-caches) for
cache limits and validation status.

## Database component development

### Bundled engine and rebuilding

The bundled worker source is in `components/database/src/`; the checked-in
`components/database/engine.jar` is embedded in the desktop executable.
`components/database/catalog.json` pins its checksum and optional driver/runtime downloads.

Main application builds do not need Java. Rebuilding the worker needs JDK 21.0.2 matching the
checksum catalog: run `pnpm database:build` to verify that generated bytes match the bundled JAR.

After source changes, run `node scripts/database-component.mjs --record`, review and commit the
bundled JAR with its source and catalog. Temporary compilation outputs stay under ignored
`components/database/target/`.

`.github/workflows/database-components.yml` manually verifies the bundled artifact; no separate
engine release is required.

### Real database and proxy checks

`pnpm test:database` skips real database tests by default. Set `UTERM_MYSQL_TEST=1`,
`UTERM_MYSQL_PASSWORD` and optionally `UTERM_MYSQL_HOST`, `UTERM_MYSQL_PORT`, `UTERM_MYSQL_USER`,
`UTERM_MYSQL_DATABASE` to enable local integration validation.

First download the matching driver to ignored `components/database/target/mysql.jar`. Tests query
metadata/constructed data and set session variables without creating or changing business tables.

Never write passwords into source files, command history or test fixtures. Enable
`UTERM_DATABASE_PROXY_TEST=1` with matching `mysql.jar`, `postgresql.jar` and `oracle.jar` in the
same ignored directory to verify all three drivers authenticate with a disposable loopback SOCKS
proxy; this routing test needs no database server.

### MongoDB driver protocol checks

The catalog pins the official Apache-2.0 MongoDB Java driver 5.13.0 (Sync, Core and BSON), verified
by size and SHA-256 and installed on demand outside the main installer. The reflection adapter lets
main application and bundled-engine builds run without downloading these drivers.

Download the three matching catalog JARs to ignored `components/database/target/mongodb/` as
`mongodb-driver-sync.jar`, `mongodb-driver-core.jar` and `bson.jar`. Set
`UTERM_MONGODB_DRIVER_TEST=1` and run
`node --experimental-strip-types --test tests/document-database.test.mjs` to connect the real Java
driver to a disposable loopback wire fixture. It checks BSON preservation, queries, aggregation,
write guards and original-document conflict checks. It never connects to existing databases and does
not establish live MongoDB deployment acceptance.

Elasticsearch checks in `pnpm test:backend` use disposable HTTP fixtures for pagination, exact
numbers, source projections and write version conditions without installing a server. Native desktop
checks use an isolated application identifier without restarting a user's active app.

### Java and TLS checks

With JDK 17 or newer, set `UTERM_DATABASE_JAVA_TEST=1` to verify Unicode, control-character and
exact-number handling in the bundled JSON layer without a database. Add `UTERM_MYSQL_TLS=1` and
`UTERM_MYSQL_CA` to enabled MySQL tests for TLS validation; session-timeout tests close only their
own test connection.

### Controlled write checks

For controlled-write validation, explicitly set `UTERM_DATABASE_WRITE_TEST=1` and run
`node --experimental-strip-types --test tests/database-maintenance.test.mjs` with the MySQL
variables above. This requires a disposable loopback server, an explicit non-3306 port and a schema
named `uterm_*`; it creates/drops only its uniquely named test tables.

Do not point it at business data. `pnpm test` caps file concurrency at four to bound parallel
Vite/DOM test processes.

SQL completion uses the existing CodeMirror SQL package as an explicit dependency; no additional
editor or grid framework is bundled.

## Installer maintenance

### npm package maintenance

The npm installer is published as `@yondfane/uterm-install`. Maintainers can run
`npm pack --dry-run` in `scripts/install` to inspect the package, then publish with
`npm publish --access public` when ready.

For development validation, run `node scripts/install/cli.mjs --help`.

### Download caches

Installer payloads support bounded retries. Feeds with installer size and SHA-256 also enable resume
and verified complete-cache reuse; older feeds still install using fresh downloads.

Caches are stored in `%LOCALAPPDATA%/uTerm/installer-cache-v1` on Windows or
`~/Library/Caches/sh.uterm.desktop/installer-cache-v1` on macOS, keeping up to four files and
pruning inactive files older than seven days on subsequent use. After forcibly terminating the macOS
script, confirm no installer is running before removing its cached `installer.lock` directory.

Scripts live in `scripts/install/`; the remote commands read scripts from the `release` branch. You
can also download installers manually from [Releases](https://github.com/YondFane/uTerm/releases).

## Project website

The GitHub Pages website lives in `site/` as an independent static page with no build step. It
provides English/Chinese content, an actual screenshot tour, illustrative feature previews, color
themes, stable downloads and installation-command copying.

Presentation media and provenance live in `site/media/`; upload its `social-preview.png` separately
for GitHub's repository social preview.

Run `pnpm site:dev` to preview at `http://127.0.0.1:1431/uTerm/` and `pnpm site:check` to verify
interactions; `UTERM_SITE_PORT` overrides the preview port.

Before deployment, select **GitHub Actions** as Source under repository Settings → Pages → Build and
deployment, and allow `release` in the `github-pages` environment's deployment rules.
`.github/workflows/pages.yml` publishes `site/` when website files change on `release`, or when
manually run from that branch.

The desktop application's `index.html` is not published. No additional domain or secret is required.

## Validation

```sh
pnpm format:check
pnpm docs:check
pnpm i18n:check
pnpm test
pnpm build
pnpm test:host
pnpm test:backend
pnpm desktop:check
```

Use `pnpm format` to format source and `pnpm docs:sync` to regenerate the documentation index. A
successful build is not interactive platform acceptance.

Localization checks use the development-only `@babel/parser` dependency to scan UI source and
registered backend messages. `pnpm test` also runs dictionary, placeholder and bilingual component
tests using development-only `jsdom`; desktop APIs and canvas renderers are mocked.

For an isolated settings preview, run `pnpm dev --port 1422` and open `/tests/i18n-preview.html`. It
uses mock desktop data and separate browser-origin settings, not live sessions.

Run shared Redis regressions separately with `pnpm test:redis`; they require TLS-enabled
`redis-server` and `openssl` on PATH. Tests start temporary loopback servers and do not access
existing databases. The command runs all 11 service checks, including seven real-server checks.

Ordinary `pnpm test:core` runs the four Redis protocol/bounds checks and two host-port close/cancel
checks, leaving the seven real-server checks ignored. `pnpm test:backend` tests the remaining Tauri
backend. Complete validation includes both layers and `pnpm test:redis`. To generate source-bound
service logs and a JSON report, place `redis-cli` on PATH as well and run
`node scripts/redis-core-smoke.mjs /absolute/temporary/evidence-directory`. The shared Redis CI
workflow builds SHA-256-verified Redis 7.4.7 with TLS and uploads these reports. This service
evidence does not establish native Redis UI acceptance. The app does not require these test
programs.

The Redis client disables default optional features, TLS reuses rustls/ring, and credential access
uses native system APIs.

## Packaging and releases

`pnpm desktop:build` packages native installers on the current OS. Run `pnpm desktop:build --help`
for bundle and target options.

Development builds use `sh.uterm.desktop.dev`; signed updater builds use `sh.uterm.desktop`.

If a macOS Rust build reports `mis-aligned LINKEDIT string pool` for a procedural-macro library, use
`CARGO_PROFILE_RELEASE_STRIP=none pnpm desktop:build` to work around the current toolchain stripping
issue; see the [Rust issue](https://github.com/rust-lang/rust/issues/157750). This setting applies
only to that build and does not change project configuration.

The release workflow builds Windows x64 and macOS ARM64/x64. Create reviewed
`uTerm-vMAJOR.MINOR.PATCH` tags from `release`, push the branch first, then the tag.

Configure `DESKTOP_UPDATER_PUBLIC_KEY`, `DESKTOP_UPDATER_PRIVATE_KEY` and
`DESKTOP_UPDATER_KEY_PASSWORD` in CI. Windows certificate signing additionally uses
`DESKTOP_WINDOWS_CERT_P12` and `DESKTOP_WINDOWS_CERT_PASSWORD`.

Never commit signing keys.

After a stable release passes CI, public-download and update-feed checks, merge the published
`release` commit into `main` and push `main`. Preserve both histories and exclude later unpublished
commits. The release skill defines conflict, branch-protection and remote verification handling. A
release is not fully wrapped up until remote `main` contains its published commit.

See [the release skill](../.agents/skills/uterm-release/SKILL.md) for the full procedure.

## Repository

| Path                     | Responsibility                                                                  |
| ------------------------ | ------------------------------------------------------------------------------- |
| `src/components/`        | React views                                                                     |
| `src/lib/`               | State, settings and pure logic                                                  |
| `src-tauri/src/`         | Desktop commands and OS integration                                             |
| `crates/utermd-local/`   | Local PTYs, replay and Agent hooks                                              |
| `components/database/`   | Bundled JDBC worker source/JAR and pinned component catalog                     |
| `tests/`                 | Frontend and build-helper tests                                                 |
| `scripts/`, `packaging/` | Build, release and documentation tools                                          |
| `.github/workflows/`     | CI and releases                                                                 |
| `docs/`                  | Current feature and validation reference                                        |
| `site/`                  | Bilingual GitHub Pages website and static assets                                |
| `LICENSE`, `NOTICE`      | Public license, copyright and English/Chinese commercial authorization guidance |
| `DESIGN.md`              | Bilingual interface rules, color tokens and design references                   |

The desktop backend and local session service have separate Cargo manifests and lockfiles. Source
and runtime assets stay within this repository.
