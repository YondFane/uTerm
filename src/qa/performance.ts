import fixtureJSON from "../../shared/fixtures/client-performance.json?raw";
import { invoke } from "@tauri-apps/api/core";
import { coreRequest } from "../lib/shared-state";
import {
  reconnectTerminalPerformanceProbe,
  terminalPerformanceSnapshot,
} from "../lib/terminal-performance-qa";

const fixture = JSON.parse(fixtureJSON) as {
  sessions: number;
  cycles: number;
  recordsPerCycle: number;
  payloadColumns: number;
  unicodeText: string;
  fileBytes: number;
  soakSeconds: number;
  pollMilliseconds: number;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
};
export function performanceSettings(platform: string) {
  return {
    language: "en" as const,
    appearance: "dark" as const,
    fontFamily: fixture.fontFamily,
    fontSize: fixture.fontSize,
    scrollback: fixture.scrollback,
    defaultShell: (platform === "windows" ? "cmd" : "default") as "cmd" | "default",
  };
}

type Context = { root: string; project: string; platform: string };
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
const pause = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause(fixture.pollMilliseconds);
  }
  throw Error(`Performance timeout: ${label}`);
}

export async function runPerformance(
  context: Context,
  scene: (name: string, checks: unknown) => Promise<void>,
) {
  assert(!/["'`$;\\\r\n]/u.test(fixture.unicodeText), "Unsafe committed output fixture");
  const snapshot = (await coreRequest("snapshot.read")) as unknown as {
    document: { settings: Record<string, unknown> };
  };
  // Seed before shared-state initialization; an out-of-queue CAS write poisons later UI mutations.
  // 在共享状态初始化前准备设置，绕过队列的 CAS 写入会阻塞后续界面修改。
  for (const [key, value] of Object.entries(performanceSettings(context.platform)))
    assert(snapshot.document.settings[key] === value, `Performance setting mismatch: ${key}`);
  const project = await until(
    () =>
      document.querySelector<HTMLButtonElement>(
        '.folder-row[data-project-id="shared-state-qa"] > .row-label',
      ),
    "temporary performance project",
  );
  project.click();
  await until(async () => {
    try {
      const selected = (await coreRequest("snapshot.read")) as unknown as {
        document: { workspace: { selectedProject: string; selectedWorktree: string | null } };
      };
      return (
        selected.document.workspace.selectedProject === "shared-state-qa" &&
        selected.document.workspace.selectedWorktree === null
      );
    } catch (error) {
      if ((error as { code?: string }).code === "WRITER_BUSY") return false;
      throw error;
    }
  }, "committed performance project selection");
  await until(() => {
    const button = document.querySelector<HTMLButtonElement>(".welcome-action.primary");
    if (
      !button?.isConnected ||
      button.disabled ||
      button.querySelector("strong")?.textContent !== "New terminal" ||
      button.getBoundingClientRect().width <= 0
    )
      return false;
    button.click();
    return true;
  }, "create measured terminal");
  const section = await until(
    () => document.querySelector<HTMLElement>(".local-session.visible[data-session-id]"),
    "measured terminal view",
  );
  const id = section.dataset.sessionId!;
  const read = (tailOnly = true) => terminalPerformanceSnapshot(id, tailOnly);
  await until(
    () => read()?.writable && (read()?.frames ?? 0) > 0,
    "first parsed frame and input ownership",
  );
  const host = () =>
    invoke<{
      pid: number;
      sessions: { spec: { id: string; shell: string }; generation: string }[];
    }>("qa_host_status");
  const original = await host();
  assert(
    original.sessions.length === fixture.sessions,
    "Measured session count differs from the common fixture",
  );
  const session = original.sessions.find((value) => value.spec.id === id);
  assert(session, "Actual hosted session missing");
  const phase = (name: string, cycle = -1) =>
    invoke("qa_scene", { name: "performance-progress", value: { phase: name, cycle } });
  const send = (command: string) => {
    const field = section.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    assert(field, "Missing actual xterm input");
    field.focus();
    const data = new DataTransfer();
    data.setData("text/plain", command);
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
  };
  const samples = [];
  const payload = "x".repeat(fixture.payloadColumns);
  for (let cycle = 0; cycle < fixture.cycles; cycle++) {
    await phase("terminal", cycle);
    const label = String(cycle).padStart(2, "0");
    const start = performance.now();
    send(
      context.platform === "windows"
        ? `echo LAT_^${label.split("").join("^")}`
        : `printf 'LAT_%s\\n' '${label}'`,
    );
    await until(() => {
      const value = read();
      return value?.text.includes(`LAT_${label}`) && value.frames === value.acknowledgedFrames;
    }, "input/output acknowledgement");
    const latency = read()!.lastAckMilliseconds - start;
    assert(latency >= 0, "Input marker matched a stale acknowledgement");
    const beforeBytes = read()!.bytes;
    const bulkStart = performance.now();
    const command =
      context.platform === "windows"
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); for($i=0;$i -lt ${fixture.recordsPerCycle};$i++){[Console]::Write(('P${label}_{0:D4}_${payload} ${fixture.unicodeText}'+[char]10),$i)}; [Console]::WriteLine(('END_{0}' -f '${label}'))"`
        : `i=0; while test "$i" -lt ${fixture.recordsPerCycle}; do printf '\\033[32mP${label}_%04d_\\033[0m${payload} ${fixture.unicodeText}\\n' "$i"; i=$((i+1)); done; printf 'END_%s\\n' '${label}'`;
    send(command);
    await until(() => {
      const value = read();
      return value?.text.includes(`END_${label}`) && value.frames === value.acknowledgedFrames;
    }, "common output parsed and acknowledged");
    const value = read(false)!;
    const records = [...value.text.matchAll(new RegExp(`P${label}_([0-9]{4})_`, "g"))].map(
      (match) => Number(match[1]),
    );
    assert(
      records.length === fixture.recordsPerCycle &&
        records.every((record, index) => record === index),
      "Measured output lost order or records",
    );
    assert(value.text.includes(fixture.unicodeText), "Measured output lost Unicode");
    samples.push({
      cycle,
      inputToParsedAckMilliseconds: latency,
      bulkMilliseconds: value.lastAckMilliseconds - bulkStart,
      renderedBytes: value.bytes - beforeBytes,
      orderedRecords: records.length,
      acknowledgedSequence: value.sequence,
    });
  }
  await phase("file-service");
  const file = "performance.txt";
  let version = "";
  const fileSamples = [];
  await coreRequest("files.mutate", {
    directory: context.project,
    action: "file",
    path: "",
    name: file,
  });
  let fileDocument = (await coreRequest("files.read", {
    directory: context.project,
    path: file,
  })) as unknown as { version: string; text: string };
  await coreRequest("files.save", {
    directory: context.project,
    path: file,
    text: "x".repeat(fixture.fileBytes),
    expected: fileDocument.version,
    force: false,
  });
  fileDocument = (await coreRequest("files.read", {
    directory: context.project,
    path: file,
  })) as unknown as { version: string; text: string };
  version = fileDocument.version;
  for (let cycle = 0; cycle < fixture.cycles; cycle++) {
    const text = "x".repeat(fixture.fileBytes - 8) + String(cycle).padStart(8, "0");
    const start = performance.now();
    await coreRequest("files.save", {
      directory: context.project,
      path: file,
      text,
      expected: version,
      force: false,
    });
    fileDocument = (await coreRequest("files.read", {
      directory: context.project,
      path: file,
    })) as unknown as { version: string; text: string };
    assert(fileDocument.text === text, "Measured file CAS roundtrip changed bytes");
    version = fileDocument.version;
    fileSamples.push(performance.now() - start);
  }
  await phase("replay");
  const resets = read()!.resets;
  const replayStart = performance.now();
  await reconnectTerminalPerformanceProbe(id);
  await until(() => {
    const value = read();
    return (
      value &&
      value.resets > resets &&
      value.writable &&
      value.frames === value.acknowledgedFrames &&
      value.text.includes(`END_${String(fixture.cycles - 1).padStart(2, "0")}`)
    );
  }, "replay retained generation");
  const replayMilliseconds = read()!.lastAckMilliseconds - replayStart;
  await phase("idle-soak");
  await pause(fixture.soakSeconds * 1000);
  const after = await host();
  assert(
    after.pid === original.pid &&
      after.sessions.find((value) => value.spec.id === id)?.generation === session.generation,
    "Measured replay/soak restarted the host or PTY",
  );
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fixtureJSON));
  await scene("performance-complete", {
    fixture,
    fixtureSHA256: [...new Uint8Array(hash)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join(""),
    client: "tauri",
    hostPID: original.pid,
    sessionCountMeasured: 1,
    cycles: samples,
    fileSaveReadMilliseconds: fileSamples,
    replayMilliseconds,
    viewport: { columns: read()!.columns, rows: read()!.rows },
    measurement:
      "Actual xterm DOM paste/Enter to parsed/acknowledged PTY output; Core IPC file service; actual attachment reconnect/replay; short CI idle soak",
    manualInputAcceptance: false,
    databasePerformanceMeasured: false,
  });
  await phase("cleanup");
  const close = section.querySelector<HTMLElement>(".session-directory");
  assert(close, "Missing session header close action");
  close.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
  await until(
    async () => !(await host()).sessions.some((value) => value.spec.id === id),
    "close measured process",
  );
  await coreRequest("host.shutdownIdle");
  await invoke("qa_request_exit");
}
