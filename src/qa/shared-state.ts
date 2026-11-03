import editorFixtureJSON from "../../shared/fixtures/editor-draft-qa.json?raw";
import gitFixtureJSON from "../../shared/fixtures/git-qa.json?raw";
import { invoke } from "@tauri-apps/api/core";
import { coreRequest } from "../lib/shared-state";
import { defaults, settingsKey } from "../lib/settings";
import { emptyWorkspace, workspaceKey } from "../lib/workspace";
import { draftKey } from "../lib/file-document";
import { editorDraftReceiptKey } from "../lib/editor-draft-handoff";
import type {
  CoreEditorDraftEntry,
  CoreFileDocument,
  CoreGitFavoriteRecoveryCatalog,
  CoreGitFavorites,
} from "../lib/core-contract.generated";

interface Context {
  root: string;
  project: string;
  phase: "initial" | "reopen" | "recover" | "editor-checkpoint" | "editor-reopen" | "git";
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
    value: { ...(checks as Record<string, unknown>), observerBusyReads },
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
  await invoke("qa_request_exit");
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
    const field = await until(
      () => document.querySelector<HTMLSelectElement>(".git-favorite-recovery-dialog select"),
      "recovery copy selector",
    );
    await until(
      () => [...field.options].some((option) => option.value === value),
      "verified recovery choice",
    );
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => {
      const text = document.querySelector<HTMLTextAreaElement>(
        ".git-favorite-recovery-dialog textarea",
      )?.value;
      return (
        field.value === value &&
        !button("Copy full preview")?.disabled &&
        text !== undefined &&
        text.trimStart().startsWith("[") === source
      );
    }, "verified favorite recovery preview");
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
  await click("Recover Git favorites…");
  await select(`backup:${revision}`);
  assert(
    document.activeElement?.textContent === "Cancel",
    "Cancel is not the initial recovery action",
  );
  await scene("git-favorite-recovery-preview", {
    actualErrorEntry: true,
    cancelDefault: true,
    verifiedAllRepositoryPreview: true,
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
