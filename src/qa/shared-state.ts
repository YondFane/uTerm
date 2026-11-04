import editorFixtureJSON from "../../shared/fixtures/editor-draft-qa.json?raw";
import gitFixtureJSON from "../../shared/fixtures/git-qa.json?raw";
import { invoke } from "@tauri-apps/api/core";
import { coreRequest } from "../lib/shared-state";
import { defaults, settingsKey } from "../lib/settings";
import { emptyWorkspace, workspaceKey } from "../lib/workspace";
import { draftKey } from "../lib/file-document";
import { editorDraftReceiptKey } from "../lib/editor-draft-handoff";
import { ContentScope } from "../lib/content-transport";
import { tauriContentPort } from "../lib/tauri-content";
import type {
  CoreEditorDraftEntry,
  CoreFileDocument,
  CoreGitFavoriteRecoveryCatalog,
  CoreGitFavorites,
} from "../lib/core-contract.generated";

interface Context {
  root: string;
  project: string;
  platform: string;
  phase:
    | "initial"
    | "reopen"
    | "recover"
    | "editor-checkpoint"
    | "editor-reopen"
    | "git"
    | "input-owner"
    | "input-viewer";
  backup?: string;
  ready: boolean;
}
const backupKey = "uterm.desktop.editorDraft.v1.backup";
const sentinel = "opaque QA draft backup retained byte-for-byte";
const editorFixture = JSON.parse(editorFixtureJSON) as {
  fileName: string;
  originalText: string;
  oldText: string;
  durableText: string;
  savedText: string;
};
const editorFile = editorFixture.fileName;
const gitQA = JSON.parse(gitFixtureJSON) as { fileName: string; worktreeName: string };
const oldEditorText = editorFixture.oldText;
const durableEditorText = editorFixture.durableText;
const savedEditorText = editorFixture.savedText;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
let observerBusyReads = 0;
let favoritePreviewReloads = 0;
async function observeCore(method: string, params?: Parameters<typeof coreRequest>[1]) {
  assert(
    ["snapshot.read", "editor.drafts.document", "git.favorites.read"].includes(method),
    "QA observer is read-only",
  );
  const result = await until(async () => {
    try {
      return { value: await coreRequest(method, params) };
    } catch (reason) {
      if ((reason as { code?: string }).code !== "WRITER_BUSY") throw reason;
      observerBusyReads++;
      return null;
    }
  }, "read-only Core observer after writer lock");
  return result.value;
}
async function until<T>(read: () => T | Promise<T>, description: string): Promise<NonNullable<T>> {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause(100);
  }
  throw Error(`QA timed out: ${description}`);
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );
}
async function click(label: string) {
  (await until(() => button(label), label)).click();
  await pause(100);
}
async function scene(name: string, checks: unknown) {
  await pause(500);
  await invoke("qa_scene", {
    name,
    value: { ...(checks as Record<string, unknown>), observerBusyReads, favoritePreviewReloads },
  });
}
export async function reportEditorRecoveryFailure(reason: unknown) {
  await scene("failure", {
    stage: "editor-handoff",
    error: String(reason),
    body: document.body.innerText.slice(0, 4000),
  });
}
async function settings() {
  const snapshot = (await observeCore("snapshot.read")) as unknown as {
    document: { settings: typeof defaults };
  };
  return snapshot.document.settings;
}
async function openSettings() {
  const open = await until(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]:not(:disabled)'),
    "settings button",
  );
  open.click();
  await click("Appearance");
}
function fontField() {
  return [...document.querySelectorAll(".settings-content label")]
    .find((l) => l.textContent?.includes("File font size"))
    ?.querySelector<HTMLInputElement>("input");
}
function showFont() {
  const input = fontField();
  assert(input, "Missing file font field");
  input.scrollIntoView({ block: "center" });
  input.focus({ preventScroll: true });
}
async function editFont(value: number) {
  const input = await until(fontField, "file font field");
  input.scrollIntoView({ block: "center" });
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
    input,
    String(value),
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.blur();
}

export async function prepare() {
  const context = await invoke<Context>("qa_context");
  if (context.phase === "git") {
    const references = (await coreRequest("git.references", {
      directory: context.project,
    })) as unknown as { repository: string };
    const key = `uterm.git.favorites:${references.repository}`;
    if (localStorage.getItem(key) === null)
      localStorage.setItem(key, '[\r\n "refs/heads/main"\r\n]');
  }
  if (
    ["initial", "editor-checkpoint"].includes(context.phase) &&
    localStorage.getItem(settingsKey) === null
  ) {
    localStorage.setItem(
      settingsKey,
      JSON.stringify({ ...defaults, language: "en", appearance: "dark" }),
    );
    const workspace = emptyWorkspace();
    workspace.projects.push({
      id: "shared-state-qa",
      name: "Temporary QA project",
      directory: context.project,
      workspaceId: "local",
      sessions: [],
    });
    localStorage.setItem(workspaceKey, JSON.stringify(workspace));
    localStorage.setItem(backupKey, sentinel);
  }
  if (context.phase === "editor-checkpoint" && localStorage.getItem(draftKey) === null) {
    const file = (await coreRequest("files.read", {
      directory: context.project,
      path: editorFile,
    })) as unknown as CoreFileDocument;
    localStorage.setItem(
      draftKey,
      " \n" +
        JSON.stringify({
          directory: context.project,
          path: editorFile,
          kind: "text",
          text: oldEditorText,
          saved: file.text,
          version: file.version,
          bom: file.bom,
          line_ending: file.line_ending,
        }) +
        "\n",
    );
  }
}

async function runEditor(context: Context) {
  const expected = context.phase === "editor-checkpoint" ? oldEditorText : durableEditorText;
  const original = localStorage.getItem(draftKey);
  const receipt = JSON.parse(localStorage.getItem(editorDraftReceiptKey) ?? "null");
  assert(original && receipt?.version === 1, "Old draft handoff was not recorded");
  assert(
    localStorage.getItem(`${draftKey}.shared-v1-backup.${receipt.legacyDigest}`) === original,
    "Versioned old draft backup changed",
  );
  const field = await until(
    () => document.querySelector<HTMLElement>(".cm-content[contenteditable=true]"),
    "real editable CodeMirror",
  );
  await until(
    () => field.innerText.includes(expected.split("\r")[0]),
    "exact retained text loaded",
  );
  const documentDraft = async () =>
    observeCore("editor.drafts.document", {
      directory: context.project,
      path: editorFile,
    }) as unknown as Promise<CoreEditorDraftEntry | null>;
  assert((await documentDraft())?.draft.text === expected, "Old/reopened shared text differs");
  await scene(context.phase === "editor-checkpoint" ? "editor-imported" : "editor-recovered", {
    expectedText: expected,
    oldSourceRetained: true,
    versionedBackupRetained: true,
  });
  const next = context.phase === "editor-checkpoint" ? durableEditorText : savedEditorText;
  field.focus();
  assert(document.execCommand("selectAll", false), "CodeMirror selectAll failed");
  assert(
    document.execCommand("insertText", false, next.replace(/\r\n/g, "\n")),
    "CodeMirror insertText failed",
  );
  if (context.phase === "editor-checkpoint") {
    await until(
      () => document.querySelector(".editor-error")?.textContent?.includes("writer"),
      "real recovery writer lock rejection",
    );
    const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Retry recovery draft",
    );
    assert(retry && !retry.disabled, "Explicit draft retry is unavailable");
    assert(field.innerText.includes(next.split("\r")[0]), "Rejected write lost editor text");
    await scene("editor-write-rejected", {
      realWriterLockRejected: true,
      editorTextRetained: true,
      explicitRetryVisible: true,
    });
    retry.click();
  }
  await until(
    async () => (await documentDraft())?.draft.text === next,
    "durable shared editor text",
  );
  assert(
    localStorage.getItem(draftKey) === original,
    "Shared editing wrote the frozen old draft key",
  );
  const file = (await coreRequest("files.read", {
    directory: context.project,
    path: editorFile,
  })) as unknown as CoreFileDocument;
  assert(
    file.text === editorFixture.originalText,
    "Recovered draft autosaved before explicit Save",
  );
  if (context.phase === "editor-checkpoint") {
    await scene("editor-durable", {
      exactText: next,
      frozenOldSource: true,
      originalFileUnchanged: true,
    });
    return;
  }
  await click("Save");
  await until(
    () => document.querySelector(".editor-save-state")?.textContent?.trim() === "Saved",
    "explicit native editor Save",
  );
  const saved = (await coreRequest("files.read", {
    directory: context.project,
    path: editorFile,
  })) as unknown as CoreFileDocument;
  assert(
    saved.text === savedEditorText && saved.bom && saved.line_ending === "\r\n",
    "Explicit save lost file bytes or metadata",
  );
  assert((await documentDraft()) === null, "Acknowledged saved draft was not removed");
  assert(
    localStorage.getItem(draftKey) === original,
    "Explicit shared save changed frozen old source",
  );
  await scene("editor-saved", {
    exactText: saved.text,
    bom: saved.bom,
    lineEnding: saved.line_ending,
    draftCleared: true,
    frozenOldSource: true,
  });
  await invoke("qa_request_exit");
}

async function runGit(context: Context) {
  const project = await until(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent?.trim() === "Temporary QA project",
      ),
    "selected QA project",
  );
  project.click();
  const entry = await until(
    () => document.querySelector<HTMLButtonElement>('.inspector-switcher button[title="Git"]'),
    "Git entry",
  );
  entry.click();
  const changed = await until(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>(".git-file")].find((b) =>
        b.textContent?.includes(gitQA.fileName),
      ),
    "Git changed file",
  );
  changed.click();
  await until(
    () => document.querySelector(".git-diff")?.textContent?.includes("TAURI_GIT_DIFF"),
    "real Git diff",
  );
  const snapshot = await invoke<{ root: string; branch: string }>("git_snapshot", {
    directory: context.project,
  });
  assert(snapshot.branch === "main", "Git selected the wrong branch");
  await scene("git-diff", {
    root: snapshot.root,
    branch: snapshot.branch,
    selectedDirectory: context.project,
    exactUnicode: true,
  });
  await click("History");
  (
    await until(
      () => document.querySelector<HTMLButtonElement>(".git-commit"),
      "Git history commit",
    )
  ).click();
  await until(
    () =>
      document
        .querySelector(".git-commit-message")
        ?.textContent?.includes("Isolated Tauri Git fixture"),
    "Git commit details",
  );
  await scene("git-history", { realCommitDetails: true });
  async function referenceMenu() {
    const reference = await until(
      () => document.querySelector<HTMLButtonElement>('[data-node="refs/heads/main"]'),
      "main branch reference",
    );
    reference.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 250,
        clientY: 200,
      }),
    );
  }
  const catalog = (await coreRequest("git.references", {
    directory: context.project,
  })) as unknown as { repository: string };
  const favoriteKey = `uterm.git.favorites:${catalog.repository}`;
  const frozenFavoriteSource = localStorage.getItem(favoriteKey);
  await until(
    () => document.querySelector('[data-node="refs/heads/main"]')?.textContent?.includes("★"),
    "imported old Git favorite",
  );
  await referenceMenu();
  await click("Unfavorite");
  await until(async () => {
    const saved = (await observeCore("git.favorites.read", {
      directory: context.project,
    })) as unknown as { references: string[] };
    return saved.references.length === 0;
  }, "shared favorite removed by actual Tauri menu");
  await referenceMenu();
  await click("Favorite branch");
  await until(
    () => document.querySelector('[data-node="refs/heads/main"]')?.textContent?.includes("★"),
    "shared favorite restored by actual Tauri menu",
  );
  assert(
    localStorage.getItem(favoriteKey) === frozenFavoriteSource,
    "Favorite actions changed frozen old source",
  );
  const oldBackup = Object.keys(localStorage).find((key) =>
    key.startsWith(`${favoriteKey}.shared-v1-backup.`),
  );
  assert(
    oldBackup && localStorage.getItem(oldBackup) === frozenFavoriteSource,
    "Old favorite backup differs",
  );
  assert(localStorage.getItem(`${favoriteKey}.shared-v1`), "Missing favorite handoff receipt");
  await scene("git-favorites", {
    sharedCore: true,
    exactOldSourceRetained: true,
    menuRemoveAndRestore: true,
    versionedBackup: true,
    receipt: true,
  });
  await runFavoriteRecovery(context);
  function input(label: string, value: string) {
    const field = document.querySelector<HTMLInputElement>(
      `dialog[open] input[aria-label="${label}"]`,
    );
    assert(field, `Missing Git form field: ${label}`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await referenceMenu();
  await click("New branch");
  input("Branch name", "qa-tauri-created");
  await pause(100);
  await click("New branch");
  await until(
    () => document.querySelector('[data-node="refs/heads/qa-tauri-created"]'),
    "new shared branch",
  );
  await scene("git-created-branch", {
    createdBranch: "qa-tauri-created",
    currentBranchUnchanged: true,
  });
  await referenceMenu();
  await click("New worktree");
  await until(
    () =>
      document.querySelector<HTMLInputElement>(
        'dialog[open] input[aria-label="Worktree directory"]',
      )?.value,
    "Worktree suggestion",
  );
  const worktree = context.root + "/" + gitQA.worktreeName;
  input("Branch name", "qa-tauri-worktree");
  await pause(100);
  input("Worktree directory", worktree);
  await pause(100);
  await click("New worktree");
  await until(async () => {
    const shared = (await observeCore("snapshot.read")) as unknown as {
      document: {
        workspace: { projects: { id: string; worktrees?: { path: string; branch: string }[] }[] };
      };
    };
    return shared.document.workspace.projects
      .find((p) => p.id === "shared-state-qa")
      ?.worktrees?.some((w) => w.branch === "qa-tauri-worktree");
  }, "durable Worktree sidebar registration");
  await until(() => !document.querySelector("dialog[open]"), "Worktree dialog dismissed");
  await scene("git-worktree", {
    branch: "qa-tauri-worktree",
    sharedWorkspaceRegistered: true,
    temporaryDirectory: worktree,
  });
  await runWorktreeDeletion();
  await runGitWriteExit(context);
  await invoke("qa_request_exit");
}

async function runGitWriteExit(context: Context) {
  await scene("git-write-prepared", { realPostCheckoutHook: true });
  const scope = new ContentScope(tauriContentPort, "qa-git-cancel-exit"),
    controller = new AbortController();
  let settled = false;
  const pending = scope
    .call(
      "git_switch_branch",
      {
        directory: context.project,
        branch: "qa-tauri-created",
        expected: "main",
      },
      controller.signal,
    )
    .then(
      () => {
        throw Error("Cancelled Git write delivered late success");
      },
      (reason) => {
        assert(reason.code === "CANCELLED", "Git cancellation lost its error code");
      },
    )
    .finally(() => {
      settled = true;
    });
  await scene("git-write-started", { actualIPCDispatched: true });
  controller.abort();
  await invoke("qa_request_exit");
  await until(
    () =>
      document.body.textContent?.includes(
        "Wait for the current operation to finish before quitting.",
      ),
    "backend Git operation exit guard",
  );
  assert(!settled, "Git cancellation released its caller before the backend write ended");
  await scene("git-write-quit-blocked", {
    cancelledCallerProtected: true,
    normalQuitRefused: true,
  });
  await pending;
  scope.close();
  const snapshot = await invoke<{ branch: string }>("git_snapshot", { directory: context.project });
  assert(snapshot.branch === "qa-tauri-created", "The actual Git write did not complete");
  await scene("git-write-completed", {
    cancellationSuppressedLateSuccess: true,
    finalBranch: snapshot.branch,
  });
}

async function runWorktreeDeletion() {
  const stored = async () =>
    (await observeCore("snapshot.read")) as unknown as {
      document: {
        workspace: { projects: { id: string; worktrees?: { id: string; path: string }[] }[] };
      };
    };
  const project = (await stored()).document.workspace.projects.find(
    (item) => item.id === "shared-state-qa",
  );
  const worktree = project?.worktrees?.find((item) => item.path.includes(gitQA.worktreeName));
  assert(worktree, "Shared QA Worktree was not registered");
  const row = () =>
    [...document.querySelectorAll<HTMLButtonElement>(".folder-row .row-label")].find((button) =>
      button.title.includes(gitQA.worktreeName),
    );
  async function review() {
    if (!row()) {
      const parent = await until(
        () =>
          document.querySelector<HTMLButtonElement>(
            '.folder-row[data-project-id="shared-state-qa"] .row-label',
          ),
        "owning project sidebar row",
      );
      if (parent.getAttribute("aria-expanded") === "false") parent.click();
    }
    const target = await until(row, "actual Worktree sidebar row");
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 180,
        clientY: 350,
      }),
    );
    await click("Delete worktree");
    const dialog = await until(
      () => document.querySelector<HTMLDialogElement>(".worktree-delete-dialog[open]"),
      "real application delete confirmation",
    );
    assert(
      dialog.textContent?.includes(gitQA.worktreeName),
      "Deletion review omitted the target path",
    );
    assert(
      document.activeElement?.textContent?.trim() === "Cancel",
      "Delete confirmation did not default to Cancel",
    );
  }
  async function confirm() {
    const button = document.querySelector<HTMLButtonElement>(
      '.worktree-delete-dialog button[type="submit"]',
    );
    assert(button, "Delete confirmation action is missing");
    button.click();
    await until(
      () => !document.querySelector(".worktree-delete-dialog[open]"),
      "confirmation handed off to guarded deletion",
    );
  }
  await review();
  await scene("git-worktree-delete-review", {
    cancelDefault: true,
    literalPathVisible: true,
    worktreeId: worktree.id,
  });
  await click("Cancel");
  await until(() => !document.querySelector(".worktree-delete-dialog[open]"), "Cancel deletion");
  assert(
    (await stored()).document.workspace.projects
      .find((item) => item.id === project!.id)
      ?.worktrees?.some((item) => item.id === worktree.id),
    "Cancel removed shared metadata",
  );
  await review();
  await confirm();
  await until(
    () =>
      /modified|untracked|uncommitted|dirty/i.test(
        document.querySelector(".workspace-error")?.textContent ?? "",
      ),
    "actual dirty Worktree refusal",
  );
  await scene("git-worktree-delete-dirty", {
    dirtyRefused: true,
    explicitRetryRequired: true,
    worktreeId: worktree.id,
  });
  await review();
  await scene("git-worktree-delete-stale", {
    projectId: project!.id,
    worktreeId: worktree.id,
    capturedReview: true,
  });
  await confirm();
  await until(
    () => document.querySelector(".workspace-error")?.textContent?.includes("Snapshot changed"),
    "stale reviewed snapshot refusal",
  );
  await scene("git-worktree-delete-conflict", {
    staleReviewRejected: true,
    worktreeId: worktree.id,
  });
  await click("Reload workspace");
  await until(() => !button("Reload workspace"), "explicit workspace reload completed");
  await review();
  await scene("git-worktree-delete-fresh-review", {
    explicitlyReloaded: true,
    worktreeId: worktree.id,
  });
  await confirm();
  await until(
    async () =>
      !(await stored()).document.workspace.projects
        .find((item) => item.id === project!.id)
        ?.worktrees?.some((item) => item.id === worktree.id),
    "actual Git deletion and metadata commit",
  );
  await until(() => !row(), "removed Worktree disappeared from sidebar");
  await scene("git-worktree-deleted", {
    cleanDeleted: true,
    sharedMetadataRemoved: true,
    worktreeId: worktree.id,
  });
}

async function runFavoriteRecovery(context: Context) {
  const favorites = (await coreRequest("git.favorites.read", {
    directory: context.project,
  })) as unknown as CoreGitFavorites;
  const checkpoint = (await coreRequest("git.favorites.write", {
    directory: context.project,
    expectedRevision: favorites.revision,
    references: [],
  })) as unknown as CoreGitFavorites;
  await coreRequest("git.favorites.write", {
    directory: context.project,
    expectedRevision: checkpoint.revision,
    references: favorites.references,
  });
  const initial = (await coreRequest(
    "git.favorites.recovery.list",
  )) as unknown as CoreGitFavoriteRecoveryCatalog;
  assert(initial.currentRevision && favorites.sourceDigest, "Missing recovery snapshot or source");
  assert(
    initial.backups.includes(initial.currentRevision),
    "Current favorite snapshot was not retained",
  );
  const revision = initial.currentRevision;
  await scene("git-favorite-recovery-ready", { revision, sourceDigest: favorites.sourceDigest });
  async function open() {
    const entry = await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          '.git-tree-tools button[aria-label="Recover Git favorites…"]',
        ),
      "actual favorite recovery toolbar action",
    );
    entry.click();
    await until(
      () => document.querySelector(".git-favorite-recovery-dialog[open]"),
      "actual favorite recovery dialog",
    );
  }
  async function select(value: string, source = false) {
    let selected = false;
    let reloads = 0;
    await until(() => {
      const dialog = document.querySelector(".git-favorite-recovery-dialog[open]");
      const error = dialog?.querySelector('[role="alert"]')?.textContent ?? "";
      if (error.includes("Another writer owns the canonical store") && reloads < 3) {
        const reload = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
          (button) => button.textContent?.trim() === "Reload recovery copies",
        );
        if (reload && !reload.disabled) {
          reload.click();
          reloads++;
          favoritePreviewReloads++;
          selected = false;
          return false;
        }
      }
      const field = dialog?.querySelector<HTMLSelectElement>("select");
      if (!field || field.disabled || ![...field.options].some((option) => option.value === value))
        return false;
      if (!selected || field.value !== value) {
        field.value = value;
        field.dispatchEvent(new Event("change", { bubbles: true }));
        selected = true;
        return false;
      }
      const text = dialog?.querySelector<HTMLTextAreaElement>("textarea")?.value;
      return (
        !button("Copy full preview")?.disabled &&
        text !== undefined &&
        text.trimStart().startsWith("[") === source
      );
    }, "verified favorite recovery preview after explicit read-only reload");
    assert(
      button("Restore all repository favorites")?.disabled === source,
      "Original source must not directly replace favorites",
    );
  }
  async function closed() {
    await until(
      () => !document.querySelector(".git-favorite-recovery-dialog[open]"),
      "recovery dialog closed",
    );
  }
  await until(() => button("Recover Git favorites…"), "visible real corrupt favorite error");
  await scene("git-favorite-recovery-lock-ready", { actualErrorEntry: true });
  await click("Recover Git favorites…");
  await until(
    () =>
      document
        .querySelector('.git-favorite-recovery-dialog[open] [role="alert"]')
        ?.textContent?.includes("Another writer owns the canonical store"),
    "actual canonical writer lock rejects the read-only recovery preview",
  );
  assert(button("Restore all repository favorites")?.disabled, "Busy preview enabled restoration");
  await scene("git-favorite-recovery-busy", {
    canonicalWriterBusy: true,
    restoreDisabled: true,
    readOnlyFailure: true,
  });
  await select(`backup:${revision}`);
  assert(
    favoritePreviewReloads > 0,
    "The busy preview did not use explicit Reload recovery copies",
  );
  assert(
    document.activeElement?.textContent === "Cancel",
    "Cancel is not the initial recovery action",
  );
  await scene("git-favorite-recovery-preview", {
    actualErrorEntry: true,
    cancelDefault: true,
    verifiedAllRepositoryPreview: true,
    recoveredAfterOwnedWriterReleased: true,
  });
  await click("Cancel");
  await closed();
  await open();
  await select(`source:${favorites.sourceDigest}`, true);
  await click("Copy full preview");
  await until(
    () =>
      document.querySelector(".git-favorite-recovery-dialog [role=status]")?.textContent ===
      "Copied the full preview.",
    "native clipboard copy acknowledgement",
  );
  await scene("git-favorite-recovery-source", {
    sourceDigest: favorites.sourceDigest,
    sourceCannotRestore: true,
    fullSourceCopied: true,
  });
  await click("Cancel");
  await closed();
  await open();
  await select(`backup:${revision}`);
  await scene("git-favorite-recovery-stale", { revision, pinnedCurrentFile: true });
  await click("Restore all repository favorites");
  await until(
    () =>
      document
        .querySelector(".git-favorite-recovery-dialog [role=alert]")
        ?.textContent?.includes("changed"),
    "visible actual stale restore conflict",
  );
  await scene("git-favorite-recovery-conflict", {
    staleRestoreRejected: true,
    explicitReloadRequired: true,
  });
  await click("Reload recovery copies");
  await select(`backup:${revision}`);
  await click("Restore all repository favorites");
  await closed();
  await until(
    () => document.querySelector('[data-node="refs/heads/main"]')?.textContent?.includes("★"),
    "Git favorites refreshed after actual restore",
  );
  await scene("git-favorite-recovery-restored", {
    verifiedSnapshotRestored: true,
    damagedBytesRetained: true,
    gitViewRefreshed: true,
  });
  await open();
  await select(`backup:${revision}`);
  await scene("git-favorite-recovery-missing", {
    explicitMissingRestore: true,
    previewReadonly: true,
  });
  await click("Restore all repository favorites");
  await closed();
  const restored = (await observeCore("git.favorites.read", {
    directory: context.project,
  })) as unknown as CoreGitFavorites;
  assert(
    JSON.stringify(restored.references) === JSON.stringify(favorites.references),
    "Missing favorite restore lost references",
  );
  await scene("git-favorite-recovery-complete", {
    exactReferencesRestored: true,
    explicitMissingRestore: true,
  });
}

async function runInputControl(context: Context) {
  const owner = context.phase === "input-owner";
  if (owner) {
    const create = await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          'button[aria-label="New terminal in Temporary QA project"]',
        ),
      "new actual terminal button",
    );
    create.click();
  }
  const section = await until(
    () => document.querySelector<HTMLElement>(".local-session.visible[data-session-id]"),
    "visible real terminal",
  );
  await until(
    () => section.querySelector('.terminal-status[aria-label="Running"]'),
    "real terminal running",
  );
  const readonly = () => section.querySelector("[data-terminal-take-control]");
  const writable = () => {
    const field = section.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    return !!field && !field.readOnly && !field.disabled && !readonly();
  };
  const display = () => {
    const screen = section.querySelector<HTMLElement>(".xterm-screen");
    const bounds = screen?.getBoundingClientRect();
    const rows = [...section.querySelectorAll(".xterm-accessibility-tree > div")];
    return {
      text: rows.map((row) => row.textContent ?? "").join(""),
      rows: rows.length,
      width: bounds?.width ?? 0,
      height: bounds?.height ?? 0,
      canvases: [...section.querySelectorAll("canvas")].map((canvas) => ({
        width: canvas.width,
        height: canvas.height,
      })),
    };
  };
  const rendered = async (marker: string) => {
    try {
      return await until(() => {
        const value = display();
        return value.width > 0 && value.height > 0 && value.text.includes(marker) && value;
      }, `actual terminal accessibility rows display ${marker}`);
    } catch (reason) {
      throw Error(`${String(reason)}; terminal display: ${JSON.stringify(display())}`);
    }
  };
  const recoverRenderer = async (marker: string) => {
    const contexts = [...section.querySelectorAll<HTMLCanvasElement>(".xterm-screen canvas")]
      .map((canvas) => canvas.getContext("webgl2"))
      .filter((context): context is WebGL2RenderingContext => context !== null);
    if (contexts.length) {
      assert(contexts.length === 1, "Unexpected multiple WebGL terminal contexts");
      const loss = contexts[0].getExtension("WEBGL_lose_context");
      assert(loss, "The actual WebGL context cannot exercise context-loss recovery");
      loss.loseContext();
    }
    const domText = await until(() => {
      const text = [...section.querySelectorAll(".xterm-rows > div")]
        .map((row) => row.textContent ?? "")
        .join("");
      return text.includes(marker) && text;
    }, "actual terminal DOM fallback renders the same shell output");
    return {
      initialRenderer: contexts.length ? "webgl2" : "dom",
      injectedContextLoss: contexts.length === 1,
      recoveredRenderer: "dom",
      domText,
      terminalDisplay: await rendered(marker),
    };
  };
  let rendererRecovery: Awaited<ReturnType<typeof recoverRenderer>>;
  const send = (command: string) => {
    const field = section.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    assert(field, "Missing actual xterm input field");
    field.focus();
    const data = new DataTransfer();
    data.setData("text/plain", command);
    field.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    field.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      }),
    );
  };
  const file = async (path: string): Promise<string | null> => {
    try {
      return (
        (await coreRequest("files.read", { directory: context.project, path })) as unknown as {
          text: string;
        }
      ).text;
    } catch (reason) {
      if (
        /No such file|cannot find|not found|找不到|不存在/i.test(
          String((reason as { message?: string }).message ?? reason),
        )
      )
        return null;
      throw reason;
    }
  };
  const sendMarker = (value: string, path: string) => {
    assert(
      /^[A-Z_]+$/.test(value) && /^[a-z-]+\.txt$/.test(path),
      "Only static shell markers are allowed",
    );
    send(
      context.platform === "windows"
        ? `'${value}' | Set-Content -Encoding UTF8 '${path}'`
        : `echo ${value} > ${path}`,
    );
  };
  const host = async () =>
    (await invoke("qa_host_status")) as {
      pid: number;
      sessions: { spec: { id: string }; generation: string }[];
    };
  const initial = await host();
  const session = initial.sessions.find((s) => s.spec.id === section.dataset.sessionId);
  assert(session, "The visible terminal has no actual hosted process");
  const identity = {
    sessionID: session.spec.id,
    generation: session.generation,
    hostPID: initial.pid,
    manualKeyboardClipboardAcceptance: false,
  };
  if (owner) {
    const initialInput = await until(() => {
      const prompt = display().text.replaceAll("\u00a0", " ").trimEnd();
      return writable() && /[$#>%]$/.test(prompt) && { writable: true, prompt: prompt.slice(-256) };
    }, "initial actual shell prompt and writable xterm input");
    sendMarker("OWNER_READY", "owner-input.txt");
    await until(
      async () => (await file("owner-input.txt"))?.includes("OWNER_READY"),
      "actual original owner input side effect",
    );
    await scene("input-owner-gpu-ready", {
      ...identity,
      initialInput,
      actualInput: true,
      terminalDisplay: await rendered("OWNER_READY"),
    });
    rendererRecovery = await recoverRenderer("OWNER_READY");
    await scene("input-owner-ready", {
      ...identity,
      initialInput,
      actualInput: true,
      rendererRecovery,
    });
    await until(readonly, "old owner becomes readonly after viewer takeover");
    sendMarker("STALE_OWNER", "stale-owner.txt");
    await until(
      async () => (await file("viewer-input.txt"))?.includes("VIEWER_READY"),
      "new owner output side effect",
    );
    await scene("input-owner-readonly", {
      ...identity,
      passive: true,
      terminalDisplay: await rendered("VIEWER_READY"),
      rendererRecovery,
    });
    assert(
      (await file("stale-owner.txt")) === null && (await file("passive-viewer.txt")) === null,
      "Passive UI input reached the real shell",
    );
    const take = readonly() as HTMLButtonElement;
    assert(take && !take.disabled, "Take input control is unavailable after viewer exit");
    take.click();
    await until(writable, "original client explicitly reacquires after ordinary viewer exit");
    sendMarker("OWNER_RETURNED", "owner-returned.txt");
    await until(
      async () => (await file("owner-returned.txt"))?.includes("OWNER_RETURNED"),
      "input survives the other application's ordinary exit",
    );
    const retained = await host();
    assert(
      retained.pid === initial.pid &&
        retained.sessions.some(
          (s) => s.spec.id === session.spec.id && s.generation === session.generation,
        ),
      "Takeover or quit replaced the process",
    );
    await scene("input-owner-returned", {
      ...identity,
      passiveInputRejected: true,
      sameHostAndGeneration: true,
      viewerQuitRetainedProcess: true,
      terminalDisplay: await rendered("OWNER_RETURNED"),
      rendererRecovery,
    });
    const close = document.querySelector<HTMLButtonElement>(".session-close");
    assert(close, "Close Session is unavailable");
    close.click();
    await until(
      async () => !(await host()).sessions.some((s) => s.spec.id === session.spec.id),
      "explicit close removes the exact process",
    );
    await scene("input-owner-closed", { ...identity, explicitClose: true });
  } else {
    await until(readonly, "second actual application attaches readonly");
    sendMarker("PASSIVE", "passive-viewer.txt");
    await scene("input-viewer-gpu-readonly", {
      ...identity,
      passive: true,
      terminalDisplay: await rendered("OWNER_READY"),
    });
    rendererRecovery = await recoverRenderer("OWNER_READY");
    await scene("input-viewer-readonly", { ...identity, passive: true, rendererRecovery });
    const take = readonly() as HTMLButtonElement;
    assert(take && !take.disabled, "The real take-control button is unavailable");
    take.click();
    await until(writable, "explicit take-control enables actual xterm input");
    sendMarker("VIEWER_READY", "viewer-input.txt");
    await until(
      async () => (await file("viewer-input.txt"))?.includes("VIEWER_READY"),
      "new owner sends actual terminal input",
    );
    assert(
      (await file("passive-viewer.txt")) === null,
      "Passive clipboard input was replayed after takeover",
    );
    await scene("input-viewer-owned", {
      ...identity,
      actualInput: true,
      explicitTakeover: true,
      passiveInputDiscarded: true,
      terminalDisplay: await rendered("VIEWER_READY"),
      rendererRecovery,
    });
  }
  await invoke("qa_request_exit");
}

export async function run(recovery: boolean) {
  try {
    const context = await invoke<Context>("qa_context");
    if (recovery) {
      assert(context.phase === "recover", "Unexpected recovery before corruption");
      await until(() => document.querySelector('[role="alert"]'), "recovery error");
      await scene("corrupt-store", { errorVisible: true });
      await click("View recovery copies");
      const label = `Restore from copy ${context.backup?.slice(0, 12)}`;
      await until(() => button(label), "chosen valid backup");
      await scene("recovery-copies", { backupListed: context.backup });
      await click(label);
      return;
    }
    await until(async () => (await invoke<Context>("qa_context")).ready, "normal quit listener");
    assert(localStorage.getItem(backupKey) === sentinel, "Auxiliary backup was changed");
    if (context.phase === "input-owner" || context.phase === "input-viewer") {
      await runInputControl(context);
      return;
    }
    if (context.phase === "editor-checkpoint" || context.phase === "editor-reopen") {
      await runEditor(context);
      return;
    }
    if (context.phase === "git") {
      await runGit(context);
      return;
    }
    if (context.phase === "initial") {
      assert(
        (await settings()).fileFontSize === defaults.fileFontSize,
        "Old defaults were not imported",
      );
      await openSettings();
      await click("Local control");
      const control = await until(
        () =>
          document.querySelector<HTMLInputElement>(
            '.settings-content input[type="checkbox"]:not(:disabled)',
          ),
        "control checkbox",
      );
      control.click();
      await until(() => control.checked, "control enabled by the actual settings UI");
      await scene("control-ready", { enabled: true });
      control.click();
      await until(() => !control.checked, "control disabled by the actual settings UI");
      await scene("control-disabled", { enabled: false });
      await click("Appearance");
      await editFont(18);
      await until(
        () =>
          getComputedStyle(document.documentElement).getPropertyValue("--file-font-size").trim() ===
          "18px",
        "first durable save publication",
      );
      assert((await settings()).fileFontSize === 18, "Published value was not stored");
      showFont();
      await scene("saved", {
        fileFontSize: 18,
        published: getComputedStyle(document.documentElement)
          .getPropertyValue("--file-font-size")
          .trim(),
      });
      await invoke("qa_external_settings");
      await editFont(19);
      await until(
        () => document.querySelector('[aria-label="Unsaved settings"]'),
        "retained failed draft",
      );
      await until(() => document.querySelector(".settings-error"), "external writer conflict");
      const alert = document.querySelector(".settings-error")!;
      assert(
        alert.textContent?.includes("Snapshot changed"),
        "Expected revision conflict was not visible",
      );
      alert.scrollIntoView({ block: "center" });
      await scene("conflict-error", { revisionConflictVisible: true });
      showFont();
      assert(fontField()?.value === "19", "Conflict discarded the user's draft");
      assert((await settings()).fileFontSize === 17, "Stale UI overwrote the external change");
      await scene("conflict-draft", { draft: 19, stored: 17, errorVisible: true });
      document.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]')?.click();
      await openSettings();
      assert(fontField()?.value === "19", "Closing and reopening Settings lost the failed draft");
      showFont();
      await invoke("qa_request_exit");
      await pause(600);
      await scene("quit-blocked", {
        aliveAfterFailedSave: true,
        draftRetainedAfterSettingsReopen: true,
      });
      await click("Reload saved settings");
      assert(fontField()?.value === "19", "Reload discarded a conflicting field draft");
      showFont();
      await invoke("qa_request_exit");
      await pause(600);
      await scene("reload-draft", {
        draft: 19,
        externalFontSize: (await settings()).fontSize,
        quitBlocked: true,
      });
      await click("Retry saving settings");
      await until(
        () => !document.querySelector('[aria-label="Unsaved settings"]'),
        "draft cleared after successful save",
      );
      assert((await settings()).fileFontSize === 19, "Explicit retry did not persist the draft");
      showFont();
      await scene("retried", { fileFontSize: 19, fontSize: (await settings()).fontSize });
    } else {
      const saved = await settings();
      assert(
        saved.fileFontSize === (context.phase === "recover" ? 17 : 19),
        "Reopen/recovery settings mismatch",
      );
      assert(saved.fontSize === 21, "Unrelated external change was lost");
      await openSettings();
      const input = await until(fontField, "reopened font field");
      showFont();
      assert(input.value === String(saved.fileFontSize), "Reopened view diverges from core");
      await scene(context.phase === "recover" ? "restored" : "reopened", {
        fileFontSize: saved.fileFontSize,
        fontSize: saved.fontSize,
        auxiliaryRetained: true,
      });
    }
    document.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]')?.click();
    await invoke("qa_request_exit");
  } catch (reason) {
    await scene("failure", { error: String(reason), body: document.body.innerText.slice(0, 4000) });
  }
}
