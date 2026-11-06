import fixtureJSON from "../../shared/fixtures/client-performance.json?raw";
import { invoke } from "@tauri-apps/api/core";
import { coreRequest } from "../lib/shared-state";
import {
  reconnectTerminalPerformanceProbe,
  terminalPerformanceSnapshot,
  delayTerminalPerformanceConsumer,
  pauseTerminalPerformanceConsumer,
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
  columns: number;
  rows: number;
  tuiFrames: number;
  slowConsumerMilliseconds: number;
  maximumFrameBytes: number;
  databaseRows: number;
  databasePayloadColumns: number;
  lastRepetitionSoakSeconds: number;
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

type Context = { root: string; project: string; platform: string; performanceLong?: boolean };
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
  observe: typeof coreRequest,
) {
  assert(!/["'`$;\\\r\n]/u.test(fixture.unicodeText), "Unsafe committed output fixture");
  const snapshot = (await observe("snapshot.read")) as unknown as {
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
      const selected = (await observe("snapshot.read")) as unknown as {
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
  for (const label of ["Hide sidebar", "Hide inspector"])
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click();
  await pause(300);
  const container = section.querySelector<HTMLElement>(".terminal");
  const screen = section.querySelector<HTMLElement>(".xterm-screen");
  assert(container && screen, "Missing actual terminal geometry");
  const initialBounds = container.getBoundingClientRect();
  container.style.width = `${initialBounds.width}px`;
  container.style.height = `${initialBounds.height}px`;
  container.style.flex = "0 0 auto";
  // Fit the real view rather than changing only reported dimensions or the host's PTY size.
  // 调整真实视图，不能只修改报告尺寸或宿主 PTY 大小。
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = read()!;
    if (current.columns === fixture.columns && current.rows === fixture.rows) break;
    const cellWidth = screen.getBoundingClientRect().width / current.columns;
    const cellHeight = screen.getBoundingClientRect().height / current.rows;
    const bounds = container.getBoundingClientRect();
    if (current.columns !== fixture.columns)
      container.style.width = `${bounds.width + (fixture.columns - current.columns + 0.25) * cellWidth}px`;
    if (current.rows !== fixture.rows)
      container.style.height = `${bounds.height + (fixture.rows - current.rows + 0.25) * cellHeight}px`;
    await pause(300);
  }
  assert(
    read()!.columns === fixture.columns && read()!.rows === fixture.rows,
    "Actual terminal did not reach the common grid",
  );
  const bounds = container.getBoundingClientRect();
  assert(
    bounds.right <= innerWidth && bounds.bottom <= innerHeight,
    "Common grid is clipped outside the actual app window",
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
  const bulk = (label: string) =>
    context.platform === "windows"
      ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); for($i=0;$i -lt ${fixture.recordsPerCycle};$i++){[Console]::Write(('P${label}_{0:D4}_${payload} ${fixture.unicodeText}'+[char]10),$i)}; [Console]::WriteLine(('END_{0}' -f '${label}'))"`
      : `i=0; while test "$i" -lt ${fixture.recordsPerCycle}; do printf '\\033[32mP${label}_%04d_\\033[0m${payload} ${fixture.unicodeText}\\n' "$i"; i=$((i+1)); done; printf 'END_%s\\n' '${label}'`;
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
    send(bulk(label));
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
  await phase("slow-consumer");
  delayTerminalPerformanceConsumer(id, fixture.slowConsumerMilliseconds);
  pauseTerminalPerformanceConsumer(id, true);
  const slowStart = performance.now();
  let slowConsumer;
  try {
    send(bulk("SL"));
    await until(() => read()?.waitingToRender, "deliberately delayed actual consumer");
    const stalled = read()!;
    const heldAt = performance.now();
    await pause(50);
    assert(
      read()!.waitingToRender &&
        read()!.receivedFrames === stalled.receivedFrames &&
        read()!.frames === stalled.frames &&
        read()!.acknowledgedFrames < read()!.receivedFrames,
      "Unacknowledged delayed consumer received another frame",
    );
    const initialGateMilliseconds = performance.now() - heldAt;
    pauseTerminalPerformanceConsumer(id, false);
    await until(
      () => read()?.text.includes("END_SL") && read()!.frames === read()!.acknowledgedFrames,
      "slow-consumer ordered output and ACK",
    );
    const records = [...read(false)!.text.matchAll(/PSL_([0-9]{4})_/gu)].map((value) =>
      Number(value[1]),
    );
    assert(
      records.length === fixture.recordsPerCycle &&
        records.every((value, index) => value === index),
      "Slow consumer lost ordered records",
    );
    assert(
      read()!.largestFrameBytes <= fixture.maximumFrameBytes,
      "Actual output frame exceeded retained-buffer budget",
    );
    slowConsumer = {
      injectedDelayMilliseconds: fixture.slowConsumerMilliseconds,
      oneOutstandingFrame: true,
      orderedRecords: records.length,
      milliseconds: read()!.lastAckMilliseconds - slowStart,
      largestFrameBytes: read()!.largestFrameBytes,
      initialGateObserved: true,
      initialGateMilliseconds,
    };
  } finally {
    pauseTerminalPerformanceConsumer(id, false);
    delayTerminalPerformanceConsumer(id, 0);
  }
  await phase("tui");
  const ansi = (posix: string, windows: string) =>
    send(
      context.platform === "windows"
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $e=[char]27; ${windows}"`
        : `printf '${posix}'`,
    );
  ansi("\\033[?1049h", "[Console]::Write($e+'[?1049h')");
  await until(() => read()?.alternateScreen, "actual alternate screen entry");
  const tuiFrameMilliseconds = [];
  for (let cycle = 0; cycle < fixture.tuiFrames; cycle++) {
    const label = String(cycle).padStart(2, "0");
    const start = performance.now();
    send(
      context.platform === "windows"
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $e=[char]27; [Console]::Write($e+'[H'+$e+'[2J'+$e+'[2;1H'+$e+'[32m${payload} ${fixture.unicodeText}'+$e+'[0m'+$e+'[6;1H'); [Console]::WriteLine(('TUI_{0}' -f '${label}'))"`
        : `printf '\\033[H\\033[2J\\033[2;1H\\033[32m${payload} ${fixture.unicodeText}\\033[0m\\033[6;1HTUI_%s\\n' '${label}'`,
    );
    await until(
      () =>
        read()?.alternateScreen &&
        read()!.text.includes(`TUI_${label}`) &&
        read()!.frames === read()!.acknowledgedFrames,
      "actual synthetic TUI redraw and ACK",
    );
    tuiFrameMilliseconds.push(read()!.lastAckMilliseconds - start);
  }
  await phase("capture");
  await scene("performance-tui", {
    actualAlternateScreen: true,
    syntheticDeterministicTUI: true,
    physicalInputLatency: false,
  });
  ansi("\\033[?1049l", "[Console]::Write($e+'[?1049l')");
  await until(() => read() && !read()!.alternateScreen, "actual normal screen restoration");
  await phase("file-setup");
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
  await phase("file-service");
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
  await phase("database-setup");
  const databaseFixture = await invoke<{ port: number; password: string }>("qa_database_fixture");
  await invoke("database_components", { action: "install", id: "postgresql" });
  const database = await invoke<{ handle: string }>("database_connect", {
    config: {
      id: crypto.randomUUID(),
      name: "Performance PostgreSQL",
      kind: "postgresql",
      host: "127.0.0.1",
      port: databaseFixture.port,
      database: "uterm_qa",
      username: "uterm_qa",
      tls: false,
      ca_file: "",
      credential_id: null,
    },
    password: databaseFixture.password,
  });
  const databaseReadMilliseconds = [];
  await phase("database");
  try {
    const expected = "x".repeat(fixture.databasePayloadColumns) + " " + fixture.unicodeText;
    for (let cycle = 0; cycle < fixture.cycles; cycle++) {
      const start = performance.now();
      const result = await invoke<{ rows: string[][] }>("database_request", {
        handle: database.handle,
        request: {
          op: "query",
          sql: `SELECT i::text, repeat('x',${fixture.databasePayloadColumns}) || ' ${fixture.unicodeText}' FROM generate_series(1,${fixture.databaseRows}) AS i ORDER BY i`,
          offset: 0,
        },
      });
      assert(
        result.rows.length === fixture.databaseRows &&
          result.rows.every((row, index) => row[0] === String(index + 1) && row[1] === expected),
        "Actual database query changed ordered text values",
      );
      databaseReadMilliseconds.push(performance.now() - start);
    }
  } finally {
    await invoke("database_disconnect", { handle: database.handle, discard: true });
  }
  send(context.platform === "windows" ? "echo REPLAY_^FINAL" : "printf 'REPLAY_%s\\n' FINAL");
  await until(
    () => read()?.text.includes("REPLAY_FINAL") && read()!.frames === read()!.acknowledgedFrames,
    "final replay checkpoint",
  );
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
      value.text.includes("REPLAY_FINAL")
    );
  }, "replay retained generation");
  const replayMilliseconds = read()!.lastAckMilliseconds - replayStart;
  const soakSecondsMeasured = context.performanceLong
    ? fixture.lastRepetitionSoakSeconds
    : fixture.soakSeconds;
  await phase("idle-soak");
  await pause(soakSecondsMeasured * 1000);
  const after = await host();
  assert(
    after.pid === original.pid &&
      after.sessions.find((value) => value.spec.id === id)?.generation === session.generation,
    "Measured replay/soak restarted the host or PTY",
  );
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fixtureJSON));
  await phase("capture");
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
    tuiFrameMilliseconds,
    slowConsumer,
    databaseReadMilliseconds,
    soakSecondsMeasured,
    viewport: { columns: read()!.columns, rows: read()!.rows },
    measurementWindowContent: { width: innerWidth, height: innerHeight },
    measurement:
      "Actual xterm DOM paste/Enter to parsed/acknowledged PTY output; Core IPC file service; actual attachment reconnect/replay; short CI idle soak",
    manualInputAcceptance: false,
    databasePerformanceMeasured: true,
    databaseMeasurement:
      "Actual PostgreSQL query through Core/JDBC; row text/order verified; excludes table painting and external server CPU/RSS",
  });
  await phase("cleanup");
  const close = section.querySelector<HTMLElement>(".session-directory");
  assert(close, "Missing session header close action");
  close.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
  await until(
    async () => !(await host()).sessions.some((value) => value.spec.id === id),
    "close measured process",
  );
  await invoke("qa_shutdown_idle");
  await invoke("qa_request_exit");
}
