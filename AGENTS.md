# uTerm development

These instructions apply to this repository. It is a self-contained Tauri desktop application.

## Branching and releases

- uTerm builds and releases from `release`. Branch work from it and target
  pull requests to it.
- Create `uTerm-vMAJOR.MINOR.PATCH` release tags from reviewed commits on
  `release`, push that branch first, then push the version tag. CI builds the
  tag's immutable commit and verifies it belongs to `origin/release`.

## Boundaries and layout

- Keep all source, assets, tests, build helpers, and documentation in this
  repository. Do not import files, Cargo path dependencies, or symlink assets
  from outside it. Copy required shared files here with their license and origin.
- `src/components/` holds React views; `src/lib/` holds state, settings, and pure
  logic. `src-tauri/src/` holds desktop commands and OS integration.
- `crates/utermd-local/` owns PTYs, background sessions, replay, and agent hooks.
- Keep the Tauri and host Cargo manifests/lockfiles separate. The host can be
  tested without compiling the WebView app. Keep package names and wire protocol
  stable unless a migration is explicitly required.
- Registry dependencies stay in `package.json` / Cargo manifests and lockfiles.
  Do not commit `node_modules`, `dist`, Cargo targets, or generated schemas.
- GitHub Actions must live in the repository's `.github/workflows/`; keep its
  desktop job as a caller of commands documented here.
- Preserve existing changes. Commit/push only when requested.

## Implementation

- Keep changes scoped. Prefer existing files and small functions over broad
  component moves or new abstractions. Comment on reasons, not obvious actions.
- Every new or changed explanatory code comment must be bilingual: English first,
  then an equivalent Chinese sentence. Do not add boilerplate comments.
- The application and user-facing documentation support Simplified Chinese and
  English only. Keep both language versions aligned when behavior changes.
- Handle asynchronous errors visibly. Keep terminal writes off the UI thread.
- Quitting detaches from the host; Close Session terminates a process. Preserve
  session IDs, replay ordering/acknowledgement, and saved-data error handling.
- Keep file access within the selected root, retain conflict checks and draft
  recovery, and keep local control authenticated and loopback-only.
- Use platform-equivalent shortcuts and commands. Avoid shell interpolation for
  file paths or arguments. Test Windows-specific behavior on Windows.
- Use direct, concrete UI copy. uTerm is free. Use session, project, workspace,
  Group with, Ungroup, and Close Session consistently. No AI attribution.

## Required documentation update on every development change

- Read `docs/features.md` and `docs/features.zh-CN.md` before changing behavior.
- Update **both** guides in the same change: affected behavior, limitations,
  and current validation evidence. Describe only the current product; do not add
  change logs, development diaries, migration narratives or archived documents.
- Keep the two translations aligned and update their front-matter `updated`
  dates. Never mark platform acceptance complete on build evidence alone.
- Update both READMEs when setup, commands, dependencies, or layout change.
- Run `pnpm docs:sync` after editing documentation and `pnpm docs:check` before
  completion. The index is generated from front matter; do not edit its rows.
  The checker verifies metadata/index consistency, not semantic translation or
  whether every code change has a corresponding documentation update.

## Validation (run from this directory)

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm docs:check
pnpm test
pnpm build
pnpm test:host
pnpm test:backend
pnpm desktop:check
```

Run checks relevant to the changed layer; path/dependency migrations require all
layers. Add focused tests for logic with a real failure mode. UI layout/focus
changes require a real app run and visual inspection. Use an isolated bundle ID
for QA and do not restart a user's active app without a request.

Record actual results and remaining platform/credential limitations in both
feature guides. Do not claim Windows or Linux runtime validation from macOS.
