# uTerm

[简体中文](README.md) · [Feature guide](docs/features.md)

uTerm is a free, self-contained desktop terminal for Windows and macOS, built with Tauri, React, TypeScript, Rust, and xterm.js.

## Features

- Local terminal and Agent sessions, organized by workspace, project, and Git worktree.
- Split panes, keyboard navigation, session links, and background session reconnection.
- Project files, text editing with conflict checks and draft recovery, Markdown and PDF preview.
- Git status, diffs, commits and worktrees; GitHub issues and pull requests.
- Agent configuration, activity and usage; configurable themes, fonts, shortcuts, Simplified Chinese and English.

Quitting detaches the window without terminating background sessions. **Close Session** terminates the selected process. The session service is authenticated and listens only on loopback.

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

## Packaging and releases

`pnpm desktop:build` packages native installers on the current OS. Run `pnpm desktop:build --help` for bundle and target options. Development builds use `sh.uterm.desktop.dev`; signed updater builds use `sh.uterm.desktop`.

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
