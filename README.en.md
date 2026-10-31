<p align="center">
  <img src="site/icon.svg" width="64" height="64" alt="uTerm" />
</p>

# uTerm

**Your project. All together.**

A terminal workspace for coding agents, Git Worktrees and remote development on Windows and macOS.
Keep terminals, code, run tasks and data connections beside the project they belong to.

**[Download uTerm](https://yondfane.github.io/uTerm/?lang=en#download)** ·
[Explore the website](https://yondfane.github.io/uTerm/?lang=en) · [简体中文](README.zh-CN.md) ·
[Feature guide](docs/features.md)

![uTerm on Windows with a sample project, split terminals, Git changes and a Worktree](site/media/workspace.png)

_An actual Windows workspace with a disposable sample project and real local shell sessions._

[Download](#download) · [Quick start](#quick-start) · [Workflows](#what-you-can-do) ·
[Install commands](#one-line-installation) · [Development](#development) ·
[License & feedback](#license-and-feedback)

## Download

| Your device         | Installer                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| Windows x64         | [Windows · .exe](https://yondfane.github.io/uTerm/?lang=en#download)       |
| macOS Apple Silicon | [Apple Silicon · .dmg](https://yondfane.github.io/uTerm/?lang=en#download) |
| macOS Intel         | [Intel · .dmg](https://yondfane.github.io/uTerm/?lang=en#download)         |

The website finds the matching installers from the latest stable release. You can also choose an
installer on [GitHub Releases](https://github.com/YondFane/uTerm/releases/latest). Desktop
installers need no Node.js or Rust; downloads require GitHub access.

macOS builds are not Apple-notarized. First launch may require approval in **System Settings →
Privacy & Security**. On Windows, follow the installation wizard.

## Quick start

1. **Add your project.** Open uTerm, choose **Add project** and select a local folder. Existing Git
   Worktrees appear under their project.
2. **Open a session.** Start a terminal, or enable an installed Agent CLI in **Settings → Agent**.
   Right-click a session and choose **Group with …** to work in split panes. Each Agent CLI uses its
   own authentication.
3. **Run and review.** Open **Java build and run** or **Python run** from the project menu or
   toolbar. Review output in the bottom panel and inspect your changes in **Git**.

Quitting detaches the window while local sessions keep running. Reopen to reconnect; **Close
Session** terminates the selected process.

Agent installation, configuration, Hooks and notifications are in **Settings → Agent**. See
[Agent setup](docs/features.md#agents-and-settings), [TRAE CLI](docs/features.md#trae-cli) and
[notifications without Hooks](docs/features.md#notifications-without-hooks).

## What you can do

| Keep the work together | In uTerm                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| **Projects & Agents**  | Organize terminals and Agents by workspace, project and Git Worktree. Split panes for parallel tasks.   |
| **Build & run**        | Build Java with Maven; run Java and Python projects with searchable logs and stop/restart controls.     |
| **Files & Git**        | Review diffs and commits, edit files with conflict checks and draft recovery, preview Markdown and PDF. |
| **Remote & data**      | Open SSH/SFTP, browse Redis, and query MySQL, PostgreSQL, Oracle, Elasticsearch and MongoDB.            |

**Java and Python keep their project context.** Switching projects brings the matching configuration
and logs. Right-click either toolbar icon to select a started task. Colored Java/Python icons in the
sidebar identify running projects.

- **Java:** Maven builds, Spring Boot development runs and JAR launches. Full JDK 8/11/17/21 and
  Maven tools install on demand. [Java and Maven guide](docs/features.md#java-and-maven-builds).
- **Python:** Scripts, modules, FastAPI, Flask and Django using your Python 3 or virtual
  environment. Prepare Python and project dependencies separately.
  [Python and logs guide](docs/features.md#python-projects-and-logs).

The interface supports English and Simplified Chinese, six palettes, configurable fonts and keyboard
shortcuts. Data tools default to read-only with guarded editing. SQL and MongoDB require Java 17+
and the selected drivers, managed on demand; Elasticsearch needs no additional runtime.

[Read the full feature guide](docs/features.md) for usage, limits and platform validation.

### See the workflow

[Open the five-step workspace tour](https://yondfane.github.io/uTerm/media/tour.html?lang=en) ·
[Watch the 30-second tour](site/media/workflow.mp4)

The tour annotates the actual Windows screenshot above. It is a screenshot tour rather than a
continuous recording, with no model requests or remote-server connections.
[Media details](site/media/README.md).

## One-line installation

macOS · Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/YondFane/uTerm/release/scripts/install/install.sh | bash
```

Windows x64 · PowerShell:

```powershell
irm https://raw.githubusercontent.com/YondFane/uTerm/release/scripts/install/install.ps1 | iex
```

With Node.js 22.13 or newer:

```sh
npx @yondfane/uterm-install
```

`pnpm dlx @yondfane/uterm-install` also starts the desktop installer. A global npm installation
manages the `uterm-install` command only, not the desktop app. Run `uterm-install --help` for
options.

The macOS script installs to `~/Applications/uTerm.app` without sudo or launching the app. Existing
installations are preserved; use in-app updates. Downloads support bounded retries and verified
cache reuse when the stable feed supplies size and SHA-256.
[Installer details](docs/features.md#one-line-installation).

## Development

Built with **Tauri · React · TypeScript · Rust · xterm.js**, with WebGL terminal rendering.

Start with the [development guide](docs/development.md) for setup, commands, repository layout,
validation and releases. Follow [AGENTS.md](AGENTS.md) and the
[documentation writing rules](docs/writing-rules.md) when contributing. Use the project's
Prettier/rustfmt and run `pnpm format` and `pnpm format:check` before committing.

## License and feedback

uTerm is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE), free for its
permitted uses. Commercial uses outside those already permitted require separate written
authorization; see [NOTICE](NOTICE) for terms and the authorization contact. Third-party components
retain their licenses.

[Report a bug or request a feature](https://github.com/YondFane/uTerm/issues/new). Include your OS,
uTerm version and steps to reproduce the issue.
