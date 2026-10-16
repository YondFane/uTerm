# uTerm

[简体中文](README.md) · [Feature guide](docs/features.md) · [Website](https://yondfane.github.io/uTerm/)

uTerm is a self-contained desktop terminal for Windows and macOS, free for noncommercial use and built with Tauri, React, TypeScript, Rust, and xterm.js.

## Features

- Local terminal and Agent sessions, organized by workspace, project, and Git worktree.
- SSH connection management using system OpenSSH, with remote terminals and SFTP editing, upload and download.
- Redis workbench with direct TCP, TLS, SSH tunnels, key browsing and controlled editing.
- Split panes, keyboard navigation, session links, and background session reconnection.
- Project files, text editing with conflict checks and draft recovery, Markdown and PDF preview.
- Git status, diffs, commits and worktrees; GitHub issues and pull requests.
- Agent configuration, activity and usage; configurable themes, fonts, shortcuts, Simplified Chinese and English.

Quitting detaches the window without terminating background sessions. **Close Session** terminates the selected process. The session service is authenticated and listens only on loopback.

## Using SSH

Click the plus beside SSH connections in the sidebar. Enter a host address, port (default 22) and username, or choose Host alias mode to inherit `~/.ssh/config` (`%USERPROFILE%\.ssh\config` on Windows). Choose automatic authentication, a private-key file/ssh-agent, or a password. Enter the password in the connection dialog and optionally save it to the system credential store; unremembered passwords must be reentered after restarting. The plus beside a connection starts a terminal; selecting its name opens remote files. Password mode confirms new host fingerprints in a native dialog; automatic/key modes confirm them in the terminal first. Windows requires the system OpenSSH Client optional feature. uTerm reuses system OpenSSH, and the server must enable SFTP. Password mode does not support jump hosts or verification codes; add encrypted keys to ssh-agent before using files/tunnels. See the [feature guide](docs/features.md#ssh-and-remote-files).

## Using Redis

Click the plus beside Redis connections in the sidebar. Enter the host, port, DB and optional credentials; Test connection checks them before saving. Direct TCP, TLS with custom CA/server name, and tunnels through an existing SSH connection with its port, username and authentication are supported. Select a saved profile and click Connect to open its workbench. Connections start read-only; Allow editing enables String/Hash, key and TTL changes. Passwords remain in memory unless saved to the system credential store. Redis servers and `redis-cli` are not bundled. See the [feature guide](docs/features.md#redis-connections-and-workbench).

## Database connections and optional components

The sidebar’s Databases section supports MySQL, PostgreSQL and Oracle service-name connections. Click the plus to configure a profile, and the app automatically detects and prefers working local Java 17 or newer. If none is found, use Install or manage connection components to choose local Java or install the runtime online/offline, then install the selected driver as needed. Interrupted or cancelled downloads retain progress; Resume download retries the remaining bytes, restarting if the source does not support resuming. The connection engine is built in and needs no separate installation. Java and database drivers are excluded from the main installer. The highlighted database icon in the footer independently shows/hides the section; hidden workbenches and connections are retained. Components are also managed under Settings → Database components. See the [feature guide](docs/features.md#database-connections-and-optional-components).

Opening Database components from the sidebar temporarily hides the project inspector. Returning to the project restores the selected tool and its left/right position; the sidebar footer stays in place.

Copy SQL and Discard SQL changes appear directly in the query toolbar. Table action menus close when clicking elsewhere or pressing Escape.

The workbench has up to eight SQL tabs sharing one explicit transaction, current/selection/all execution, dialect/schema completion, formatting and in-memory history. Double-click a table for Data/Structure views and prepared server filters. Enable editing to stage supported primary-key table changes, preview their SQL and apply them before explicit commit; conflicts preserve drafts and earlier SQL writes. Export loaded pages as CSV/JSON or inspect a read query's execution plan. The grid renders visible rows/columns, supports range copying and keeps pagination at the bottom. Read-only browsing reuses the primary worker; editing uses a lazy independent browser connection. See the [implementation plan](docs/database-workbench-plan.md) and [feature guide](docs/features.md#database-connections-and-optional-components) for limits and usage.

The bundled worker source is in `components/database/src/`; the checked-in `components/database/engine.jar` is embedded in the desktop executable. `components/database/catalog.json` pins its checksum and optional driver/runtime downloads. Main application builds do not need Java. Rebuilding the worker needs JDK 26.0.2.1 matching the checksum catalog: run `pnpm database:build` to verify that generated bytes match the bundled JAR. After source changes, run `node scripts/database-component.mjs --record`, review and commit the bundled JAR with its source and catalog. Temporary compilation outputs stay under ignored `components/database/target/`. `.github/workflows/database-components.yml` manually verifies the bundled artifact; no separate engine release is required.

`pnpm test:database` skips real database tests by default. Set `UTERM_MYSQL_TEST=1`, `UTERM_MYSQL_PASSWORD` and optionally `UTERM_MYSQL_HOST`, `UTERM_MYSQL_PORT`, `UTERM_MYSQL_USER`, `UTERM_MYSQL_DATABASE` to enable local integration validation. First download the matching driver to ignored `components/database/target/mysql.jar`. Tests query metadata/constructed data and set session variables without creating or changing business tables. Never write passwords into source files, command history or test fixtures. Enable `UTERM_DATABASE_PROXY_TEST=1` with matching `mysql.jar`, `postgresql.jar` and `oracle.jar` in the same ignored directory to verify all three drivers authenticate with a disposable loopback SOCKS proxy; this routing test needs no database server.

With JDK 17 or newer, set `UTERM_DATABASE_JAVA_TEST=1` to verify Unicode, control-character and exact-number handling in the bundled JSON layer without a database. Add `UTERM_MYSQL_TLS=1` and `UTERM_MYSQL_CA` to enabled MySQL tests for TLS validation; session-timeout tests close only their own test connection.

For controlled-write validation, explicitly set `UTERM_DATABASE_WRITE_TEST=1` and run `node --experimental-strip-types --test tests/database-maintenance.test.mjs` with the MySQL variables above. This requires a disposable loopback server, an explicit non-3306 port and a schema named `uterm_*`; it creates/drops only its uniquely named test tables. Do not point it at business data. `pnpm test` caps file concurrency at four to bound parallel Vite/DOM test processes. SQL completion uses the existing CodeMirror SQL package as an explicit dependency; no additional editor or grid framework is bundled.

## One-line installation

Using npm or pnpm (requires Node.js 22.13 or newer):

```sh
npx @yondfane/uterm-install
# or
pnpm dlx @yondfane/uterm-install
```

Alternatively, install the command globally, then run the installer:

```sh
npm install -g @yondfane/uterm-install
# or pnpm add -g @yondfane/uterm-install
uterm-install
```

Global installation only adds the command; running `uterm-install` installs the desktop application. Use `uterm-install --help` for help. The package uses no install lifecycle scripts. Removing the npm package does not uninstall the desktop application.

The npm installer is published as `@yondfane/uterm-install`. Maintainers can run `npm pack --dry-run` in `scripts/install` to inspect the package, then publish with `npm publish --access public` when ready. For development validation, run `node scripts/install/cli.mjs --help`.

macOS (Apple Silicon / Intel), run in Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/YondFane/uTerm/release/scripts/install/install.sh | bash
```

Windows x64, run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/YondFane/uTerm/release/scripts/install/install.ps1 | iex
```

GitHub access is required. macOS installs to `~/Applications/uTerm.app`; open it from Finder when finished. An existing user or system installation stops the script; use in-app updates instead. The build is not notarized by Apple, so first launch may require approval in Privacy & Security. Windows downloads the stable installer and opens its wizard; follow its prompts. Node.js, Rust and an administrator terminal are not required.

Scripts live in `scripts/install/`; the remote commands read scripts from the `release` branch. You can also download installers manually from [Releases](https://github.com/YondFane/uTerm/releases).

## Development

Agent settings can install OpenCode, Claude, Codex and Gemini after confirmation using the local Node.js/npm installation. This requires internet access and permission to write npm's global prefix. Agent packages are optional and are not bundled with uTerm; other programs can be installed manually and configured by executable path.

Launch at login uses the Rust dependency `tauri-plugin-autostart` and can be toggled in Settings → General. No additional JavaScript dependency is required.

Requirements: Node.js 22.13 or newer, pnpm 11.22.0, Rust stable and Git. Windows requires the MSVC toolchain, Visual Studio C++ Build Tools, Windows SDK and WebView2. macOS requires Xcode command-line tools.

```sh
pnpm install --frozen-lockfile
pnpm uterm:dev
```

`pnpm dev` starts a browser-only frontend preview; desktop file, process and OS integrations require the Tauri app.

## Project website

The GitHub Pages website lives in `site/` as an independent static page with no build step. It provides English/Chinese content, illustrative feature previews, color themes, stable downloads and installation-command copying. Run `pnpm site:dev` to preview at `http://127.0.0.1:1431/uTerm/` and `pnpm site:check` to verify interactions; `UTERM_SITE_PORT` overrides the preview port.

Before deployment, select **GitHub Actions** as Source under repository Settings → Pages → Build and deployment, and allow `release` in the `github-pages` environment's deployment rules. `.github/workflows/pages.yml` publishes `site/` when website files change on `release`, or when manually run from that branch. The desktop application's `index.html` is not published. No additional domain or secret is required.

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

Use `pnpm format` to format source and `pnpm docs:sync` to regenerate the documentation index. A successful build is not interactive platform acceptance.

Localization checks use the development-only `@babel/parser` dependency to scan UI source and registered backend messages. `pnpm test` also runs dictionary, placeholder and bilingual component tests using development-only `jsdom`; desktop APIs and canvas renderers are mocked. For an isolated settings preview, run `pnpm dev --port 1422` and open `/tests/i18n-preview.html`. It uses mock desktop data and separate browser-origin settings, not live sessions.

Run Redis integration tests separately with `pnpm test:redis`; they require TLS-enabled `redis-server` and `openssl` on PATH. Tests start temporary loopback servers and do not access existing databases. Ordinary `pnpm test:backend` marks four real-server tests ignored and runs the Redis-independent budget/timeout tests; complete validation requires both commands. The app does not require these test programs. The Redis client disables default optional features, TLS reuses rustls/ring, and credential access uses native system APIs.

## Packaging and releases

`pnpm desktop:build` packages native installers on the current OS. Run `pnpm desktop:build --help` for bundle and target options. Development builds use `sh.uterm.desktop.dev`; signed updater builds use `sh.uterm.desktop`.

If a macOS Rust build reports `mis-aligned LINKEDIT string pool` for a procedural-macro library, use `CARGO_PROFILE_RELEASE_STRIP=none pnpm desktop:build` to work around the current toolchain stripping issue; see the [Rust issue](https://github.com/rust-lang/rust/issues/157750). This setting applies only to that build and does not change project configuration.

The release workflow builds Windows x64 and macOS ARM64/x64. Create reviewed `uTerm-vMAJOR.MINOR.PATCH` tags from `release`, push the branch first, then the tag. Configure `DESKTOP_UPDATER_PUBLIC_KEY`, `DESKTOP_UPDATER_PRIVATE_KEY` and `DESKTOP_UPDATER_KEY_PASSWORD` in CI. Windows certificate signing additionally uses `DESKTOP_WINDOWS_CERT_P12` and `DESKTOP_WINDOWS_CERT_PASSWORD`. Never commit signing keys.

## Repository

| Path | Responsibility |
| --- | --- |
| `src/components/` | React views |
| `src/lib/` | State, settings and pure logic |
| `src-tauri/src/` | Desktop commands and OS integration |
| `crates/utermd-local/` | Local PTYs, replay and Agent hooks |
| `components/database/` | Bundled JDBC worker source/JAR and pinned component catalog |
| `tests/` | Frontend and build-helper tests |
| `scripts/`, `packaging/` | Build, release and documentation tools |
| `.github/workflows/` | CI and releases |
| `docs/` | Current feature and validation reference |
| `site/` | Bilingual GitHub Pages website and static assets |
| `LICENSE`, `NOTICE` | Public license, copyright and English/Chinese commercial authorization guidance |
| `DESIGN.md` | Bilingual interface rules, color tokens and design references |

The desktop backend and local session service have separate Cargo manifests and lockfiles. Source and runtime assets stay within this repository.
