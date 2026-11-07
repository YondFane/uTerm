import { renderedText, terminalInputReady } from "./qa-legacy-transition-buffer";
import { invoke } from "@tauri-apps/api/core";
import { readSettings, settingsKey } from "./lib/settings";
import { readWorkspace, workspaceKey } from "./lib/workspace";
import { draftKey, readDraft } from "./lib/file-document";

type Host = { pid: number; sessions: { spec: { id: string }; generation: string }[] };
type Context = {
  phase: "before" | "rollback";
  project: string;
  projectID: string;
  fileName: string;
  draftText: string;
  markerSuffix: string;
  replayMarker?: string;
  seed: Record<string, string>;
  expected?: { id: string; generation: string; hostPID: number; fontSize: number };
};
let context: Context;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause(50);
  }
  throw Error("Historical application QA timeout: " + label);
}
export async function seedLegacyTransition() {
  context = await invoke<Context>("qa_legacy_context");
  const key = "qa.transition.seeded-phase";
  if (localStorage.getItem(key) !== context.phase) {
    const before = Object.fromEntries(
      Object.keys(localStorage)
        .filter((name) => name.startsWith("uterm."))
        .map((name) => [name, localStorage.getItem(name)]),
    );
    localStorage.setItem("qa.transition.backup." + context.phase, JSON.stringify(before));
    for (const name of Object.keys(before)) localStorage.removeItem(name);
    for (const [name, value] of Object.entries(context.seed)) localStorage.setItem(name, value);
    localStorage.setItem(key, context.phase);
  }
}
export async function runLegacyTransition() {
  try {
    const project = await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          `.folder-row[data-project-id="${context.projectID}"] > .row-label`,
        ),
      "historical project list",
    );
    if (context.replayMarker) {
      // Re-selecting the project also autosaves; inspect the recovered selection without navigation.
      // 重选项目也会自动保存；只核对恢复的选择，不进行导航。
      assert(
        readWorkspace(localStorage.getItem(workspaceKey)).selectedProject === context.projectID,
        "Historical project selection was not recovered",
      );
    } else project.click();
    if (
      context.phase === "before" &&
      !context.replayMarker &&
      readWorkspace(localStorage.getItem(workspaceKey)).selectedSession === null
    ) {
      const button = await until(
        () => document.querySelector<HTMLButtonElement>(".welcome-action.primary:not(:disabled)"),
        "historical new terminal",
      );
      button.click();
    }
    const section = await until(
      () => document.querySelector<HTMLElement>(".local-session.visible[data-session-id]"),
      "historical actual terminal",
    );
    const id = section.dataset.sessionId!;
    const host = await until(async () => {
      try {
        const value = await invoke<Host>("qa_legacy_host");
        return value.sessions.some((session) => session.spec.id === id) ? value : null;
      } catch {
        return null;
      }
    }, "historical hosted session");
    const session = host.sessions.find((value) => value.spec.id === id)!;
    let renderedCheckpoint = context.replayMarker;
    if (renderedCheckpoint) {
      assert(
        /^(LEGACY_BEFORE_[a-f0-9]{32}|TRANSITION_REOPEN)$/u.test(renderedCheckpoint),
        "Invalid retained checkpoint",
      );
      // Switching away from a recovered editor autosaves; observe real replay without changing the file.
      // 切离恢复编辑器会自动保存；观察真实回放，同时保留原文件。
      await until(
        () =>
          document
            .querySelector(".cm-content[contenteditable=true]")
            ?.textContent?.includes(context.draftText.trim()),
        "historical visible recovered editor",
      );
      await until(
        () => renderedText(section).replace(/\s/g, "").includes(renderedCheckpoint!),
        "historical retained real PTY replay",
      );
    } else {
      await until(() => terminalInputReady(section), "historical attached terminal input");
      const field = await until(
        () => section.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea:not(:disabled)"),
        "historical terminal input",
      );
      field.focus();
      const data = new DataTransfer();
      const marker = context.phase.toUpperCase() + "_" + context.markerSuffix;
      assert(
        /^(BEFORE|ROLLBACK)_[a-f0-9]{32}$/u.test(marker),
        "Invalid committed QA output marker",
      );
      data.setData("text/plain", `printf 'LEGACY_%s\n' '${marker}'`);
      field.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
      for (const type of ["keydown", "keyup"])
        field.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
      await until(
        () =>
          renderedText(section)
            .replace(/\s/g, "")
            .includes("LEGACY_" + marker),
        "historical rendered actual PTY marker",
      );
      renderedCheckpoint = "LEGACY_" + marker;
    }
    if (context.phase === "before" && !context.replayMarker) {
      const file = await invoke<{
        text: string;
        version: string;
        bom: boolean;
        line_ending: string;
      }>("file_read", { directory: context.project, path: context.fileName });
      // Seed a labelled draft through real historical readers and durable WebView storage.
      // 经真实历史读取器与持久 WebView 存储准备明确标注的测试草稿。
      const draft = {
        ...file,
        directory: context.project,
        path: context.fileName,
        kind: "text",
        text: context.draftText,
        saved: file.text,
      };
      readDraft(JSON.stringify(draft));
      localStorage.setItem(draftKey, JSON.stringify(draft));
    } else if (context.phase === "rollback") {
      assert(
        context.expected &&
          id === context.expected.id &&
          host.pid === context.expected.hostPID &&
          session.generation === context.expected.generation,
        "Rollback replaced the historical host/session",
      );
      assert(
        readSettings(localStorage.getItem(settingsKey)).fontSize === context.expected.fontSize,
        "Rollback lost the latest native settings",
      );
      assert(
        readDraft(localStorage.getItem(draftKey)!).text === context.draftText,
        "Rollback lost the latest native draft",
      );
    } else {
      assert(
        readDraft(localStorage.getItem(draftKey)!).text === context.draftText,
        "Interrupted restart lost the durable legacy draft",
      );
    }
    const values = Object.fromEntries(
      Object.keys(localStorage)
        .filter((name) => name.startsWith("uterm."))
        .map((name) => [name, localStorage.getItem(name)]),
    );
    const workspace = readWorkspace(values[workspaceKey]!);
    assert(workspace.selectedSession === id, "Historical session selection was not durable");
    await invoke("qa_legacy_export", {
      values,
      checks: {
        actualHistoricalApp: true,
        actualDOMInputAndPTY: !context.replayMarker,
        actualPTYReplayWithRecoveredEditor: Boolean(context.replayMarker),
        renderedCheckpoint,
        actualHistoricalXtermBufferRead: true,
        simulatedInitialDraftInput: context.phase === "before" && !context.replayMarker,
        unchangedHistoricalReaders: true,
        id,
        generation: session.generation,
        hostPID: host.pid,
        workspace,
        settings: readSettings(values[settingsKey]),
        draft: readDraft(values[draftKey]!),
      },
    });
    await until(
      () => invoke<boolean>("qa_legacy_capture_ack", { phase: context.phase }),
      "owned historical window capture",
    );
    // Keep the durable draft and the ordinary quit guard intact for the coordinator's crash.
    // 保留持久草稿及正常退出保护，等待协调器执行实际崩溃测试。
    await new Promise(() => {});
  } catch (error) {
    document.body.dataset.transitionFailure = String(error);
    await invoke("qa_legacy_export", { values: {}, checks: { error: String(error) } });
    throw error;
  }
}
