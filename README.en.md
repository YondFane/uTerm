# uTerm

[简体中文](README.md) · [Feature guide](docs/features.md)

uTerm is a self-contained desktop terminal for Windows and macOS, free for noncommercial use and built with Tauri, React, TypeScript, Rust, and xterm.js.

## License and commercial authorization

This source tree uses [PolyForm Noncommercial 1.0.0](LICENSE). Noncommercial use and other purposes expressly permitted by the license are free of charge. Commercial use outside those permissions requires **prior, separate written authorization from YondFane**. The license's personal-use, noncommercial-organization and fair-use provisions remain intact. Commercial business operations, commercial redistribution or resale, integration into commercial products, and paid or hosted services require separate authorization when not already permitted by the license.

See [NOTICE](NOTICE) for authorization requests and the aligned English/Chinese explanation. YondFane retains the right to commercialize and separately license code for which YondFane holds the necessary rights. This is source-available software, not OSI-approved open source. Third-party dependencies and assets retain their own licenses.

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

The object tree browses catalogs/schemas, tables and views. Double-click a table to open separate Data/Structure views while preserving the SQL draft and query result. Resize the object browser, SQL/result split and result columns; pagination stays at the bottom. Results support range selection, copying with headers and cell-value inspection. Table previews use an independent read-only connection without committing or rolling back SQL transactions. See the [database workbench implementation plan](docs/database-workbench-plan.md) for the three phases and size budget.

The bundled worker source is in `components/database/src/`; the checked-in `components/database/engine.jar` is embedded in the desktop executable. `components/database/catalog.json` pins its checksum and optional driver/runtime downloads. Main application builds do not need Java. Rebuilding the worker needs JDK 26.0.2.1 matching the checksum catalog: run `pnpm database:build` to verify that generated bytes match the bundled JAR. After source changes, run `node scripts/database-component.mjs --record`, review and commit the bundled JAR with its source and catalog. Temporary compilation outputs stay under ignored `components/database/target/`. `.github/workflows/database-components.yml` manually verifies the bundled artifact; no separate engine release is required.

`pnpm test:database` skips real database tests by default. Set `UTERM_MYSQL_TEST=1`, `UTERM_MYSQL_PASSWORD` and optionally `UTERM_MYSQL_HOST`, `UTERM_MYSQL_PORT`, `UTERM_MYSQL_USER`, `UTERM_MYSQL_DATABASE` to enable local integration validation. First download the matching driver to ignored `components/database/target/mysql.jar`. Tests query metadata/constructed data and set session variables without creating or changing business tables. Never write passwords into source files, command history or test fixtures. Enable `UTERM_DATABASE_PROXY_TEST=1` with matching `mysql.jar`, `postgresql.jar` and `oracle.jar` in the same ignored directory to verify all three drivers authenticate with a disposable loopback SOCKS proxy; this routing test needs no database server.

With JDK 17 or newer, set `UTERM_DATABASE_JAVA_TEST=1` to verify Unicode, control-character and exact-number handling in the bundled JSON layer without a database. Add `UTERM_MYSQL_TLS=1` and `UTERM_MYSQL_CA` to enabled MySQL tests for TLS validation; session-timeout tests close only their own test connection.

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
| `LICENSE`, `NOTICE` | Public license, copyright and English/Chinese commercial authorization guidance |
| `DESIGN.md` | Bilingual interface rules, color tokens and design references |

The desktop backend and local session service have separate Cargo manifests and lockfiles. Source and runtime assets stay within this repository.
