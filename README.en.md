# uTerm

[简体中文](README.md) · [Feature guide](docs/features.md)

uTerm is a free, self-contained desktop terminal for Windows and macOS, built with Tauri, React, TypeScript, Rust, and xterm.js.

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

Click the plus beside SSH connections in the sidebar. Enter a Host alias from `~/.ssh/config` (`%USERPROFILE%\.ssh\config` on Windows), choose the remote system and an optional file root. The plus beside a connection starts an SSH terminal; confirm a new host fingerprint there. Select the connection name to open remote files. Files require noninteractive key or ssh-agent authentication; passwords can be entered in the terminal and are not stored. Windows requires the system OpenSSH Client optional feature. uTerm does not bundle SSH executables; SFTP adds a small protocol dependency and reuses the existing async runtime. The server must enable SFTP. See the [feature guide](docs/features.md#ssh-and-remote-files) for limits and acceptance status.

## Using Redis

Click the plus beside Redis connections in the sidebar. Enter the host, port, DB and optional credentials; Test connection checks them before saving. Direct TCP, TLS with custom CA/server name, and tunnels through an existing SSH alias are supported. Select a saved profile and click Connect to open its workbench. Connections start read-only; Allow editing enables String/Hash, key and TTL changes. Passwords remain in memory unless saved to the system credential store. Redis servers and `redis-cli` are not bundled. See the [feature guide](docs/features.md#redis-connections-and-workbench).

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
| `tests/` | Frontend and build-helper tests |
| `scripts/`, `packaging/` | Build, release and documentation tools |
| `.github/workflows/` | CI and releases |
| `docs/` | Current feature and validation reference |
| `DESIGN.md` | Bilingual interface rules, color tokens and design references |

The desktop backend and local session service have separate Cargo manifests and lockfiles. Source and runtime assets stay within this repository.
