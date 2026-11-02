import { invoke } from "@tauri-apps/api/core";
import { coreRequest } from "../lib/shared-state";
import { defaults, settingsKey } from "../lib/settings";
import { emptyWorkspace, workspaceKey } from "../lib/workspace";

interface Context {
  project: string;
  phase: "initial" | "reopen" | "recover";
  backup?: string;
  ready: boolean;
}
const backupKey = "uterm.desktop.editorDraft.v1.backup";
const sentinel = "opaque QA draft backup retained byte-for-byte";
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
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
  await invoke("qa_scene", { name, value: checks });
}
async function settings() {
  const snapshot = (await coreRequest("snapshot.read")) as unknown as {
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
  if (context.phase === "initial" && localStorage.getItem(settingsKey) === null) {
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
    if (context.phase === "initial") {
      assert(
        (await settings()).fileFontSize === defaults.fileFontSize,
        "Old defaults were not imported",
      );
      await openSettings();
      await editFont(18);
      await until(
        () =>
          getComputedStyle(document.documentElement).getPropertyValue("--file-font-size").trim() ===
          "18px",
        "first durable save publication",
      );
      assert((await settings()).fileFontSize === 18, "Published value was not stored");
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
      fontField()?.scrollIntoView({ block: "center" });
      assert(fontField()?.value === "19", "Conflict discarded the user's draft");
      assert((await settings()).fileFontSize === 17, "Stale UI overwrote the external change");
      await scene("conflict-draft", { draft: 19, stored: 17, errorVisible: true });
      document.querySelector<HTMLButtonElement>('button[aria-label="Close settings"]')?.click();
      await openSettings();
      assert(fontField()?.value === "19", "Closing and reopening Settings lost the failed draft");
      await invoke("qa_request_exit");
      await pause(600);
      await scene("quit-blocked", {
        aliveAfterFailedSave: true,
        draftRetainedAfterSettingsReopen: true,
      });
      await click("Reload saved settings");
      assert(fontField()?.value === "19", "Reload discarded a conflicting field draft");
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
      input.scrollIntoView({ block: "center" });
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
