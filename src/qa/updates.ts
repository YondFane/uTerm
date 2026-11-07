import { Channel, invoke } from "@tauri-apps/api/core";
import { coreRequest } from "../lib/shared-state";
import { terminalPerformanceSnapshot } from "../lib/terminal-performance-qa";
import type { CoreEditorDraftEntry, CoreFileDocument } from "../lib/core-contract.generated";
import fixtureJSON from "../../shared/fixtures/windows-updates-qa.json?raw";

const qa = JSON.parse(fixtureJSON) as {
  draftText: string;
  editorGuardError: string;
  databaseGuardError: string;
  transferGuardError: string;
};

type Context = { project: string; root: string };
type Host = { pid: number; sessions: { spec: { id: string }; generation: string }[] };
type Checkpoint = { session: string; host: number; generation: string; pid: number; text: string };
type State = { version: string; pid: number; checkpoint?: Checkpoint };
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
async function until<T>(read: () => T | Promise<T>, name: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause(50);
  }
  throw Error(`Windows updater timeout: ${name}`);
}
const fixture = (mode: string, checkpoint?: Checkpoint) =>
  invoke<State>("qa_updates", { mode, checkpoint });
const host = () => invoke<Host>("qa_host_status");
async function click(label: string, selector = "button") {
  const button = await until(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>(selector)].find(
        (value) => value.textContent?.trim() === label && !value.disabled,
      ),
    label,
  );
  button.click();
}
async function download() {
  const events = new Channel<{ downloaded: number; total: number | null }>();
  let bytes = 0;
  events.onmessage = (value) => {
    bytes = value.downloaded;
  };
  await invoke("update_download", { events });
  assert(bytes > 0, "Actual updater did not report downloaded bytes");
}
async function draft(context: Context, observe: typeof coreRequest) {
  return observe("editor.drafts.document", {
    directory: context.project,
    path: "update-draft.txt",
  }) as unknown as Promise<CoreEditorDraftEntry>;
}
function send(id: string, text: string) {
  const field = document.querySelector<HTMLTextAreaElement>(
    `[data-session-id="${id}"] .xterm-helper-textarea`,
  );
  assert(field, "Missing retained actual terminal input");
  field.focus();
  const data = new DataTransfer();
  data.setData("text/plain", text);
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
}

export async function runUpdates(
  context: Context,
  scene: (name: string, checks: unknown) => Promise<void>,
  observe: typeof coreRequest,
) {
  const state = await fixture("context");
  if (state.version === "0.2.5") {
    const checkpoint = state.checkpoint;
    assert(checkpoint, "Updated process lacks its old checkpoint");
    assert(state.pid !== checkpoint.pid, "Update did not relaunch the application");
    const current = await host();
    assert(
      current.pid === checkpoint.host &&
        current.sessions.some(
          (value) =>
            value.spec.id === checkpoint.session && value.generation === checkpoint.generation,
        ),
      "Update replaced the live host or session generation",
    );
    assert(
      (await draft(context, observe)).draft.text === checkpoint.text,
      "Update lost the retained Core draft bytes",
    );
    await until(
      () => terminalPerformanceSnapshot(checkpoint.session)?.writable,
      "updated terminal ownership",
    );
    send(checkpoint.session, "echo SDK_^UPDATED");
    await until(
      () => terminalPerformanceSnapshot(checkpoint.session)?.text.includes("SDK_UPDATED"),
      "fresh updated PTY output",
    );
    await scene("installed-relaunched", {
      actualSignedInstallAndRelaunch: true,
      oldVersion: "0.2.4",
      newVersion: state.version,
      originalPID: checkpoint.pid,
      relaunchedPID: state.pid,
      sameHostAndGeneration: true,
      retainedDraftBytes: true,
      inputAfterRelaunch: true,
      draftInput: "explicit simulated Core draft; actual persistence and upgrade",
    });
    const close = document.querySelector<HTMLElement>(
      `[data-session-id="${checkpoint.session}"] .session-directory`,
    );
    assert(close, "Missing actual updated terminal close control");
    close.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    await until(
      async () => !(await host()).sessions.some((value) => value.spec.id === checkpoint.session),
      "explicit updated terminal close",
    );
    await invoke("qa_shutdown_idle");
    await scene("complete", {
      passed: true,
      explicitSessionClose: true,
      sdk: "tauri-plugin-updater 2.12.0",
      automaticUpdatesOff: true,
      productionDataAccess: false,
    });
    await invoke("qa_request_exit");
    return;
  }
  assert(state.version === "0.2.4", "Unexpected initial QA package version");
  const snapshot = (await observe("snapshot.read")) as unknown as {
    document: {
      settings: { automaticUpdates: boolean };
      workspace: { selectedProject: string | null };
    };
  };
  assert(
    !snapshot.document.settings.automaticUpdates,
    "Updater fixture enabled automatic updates by default",
  );
  await pause(16_000);
  await fixture("good");
  const project = await until(
    () =>
      document.querySelector<HTMLButtonElement>(
        '.folder-row[data-project-id="shared-state-qa"] > .row-label',
      ),
    "fixture project",
  );
  project.click();
  await until(
    async () =>
      ((await observe("snapshot.read")) as unknown as typeof snapshot).document.workspace
        .selectedProject === "shared-state-qa",
    "committed project selection",
  );
  const create = await until(
    () => document.querySelector<HTMLButtonElement>(".welcome-action.primary:not(:disabled)"),
    "new terminal",
  );
  create.click();
  const terminal = await until(
    () => document.querySelector<HTMLElement>(".local-session.visible[data-session-id]"),
    "actual hosted terminal",
  );
  const id = terminal.dataset.sessionId!;
  await until(() => terminalPerformanceSnapshot(id)?.writable, "terminal ownership");
  const original = await host();
  const session = original.sessions.find((value) => value.spec.id === id);
  assert(session, "Missing actual hosted session");
  await coreRequest("files.mutate", {
    directory: context.project,
    action: "file",
    path: "",
    name: "update-draft.txt",
  });
  const file = (await coreRequest("files.read", {
    directory: context.project,
    path: "update-draft.txt",
  })) as unknown as CoreFileDocument;
  await coreRequest("editor.drafts.import", {});
  const text = qa.draftText;
  await coreRequest("editor.drafts.putDocument", {
    expectedDraftRevision: null,
    draft: {
      directory: context.project,
      path: "update-draft.txt",
      kind: "text",
      text,
      saved: file.text,
      version: file.version,
      bom: file.bom,
      line_ending: file.line_ending,
    },
  });
  const checkpoint = {
    session: id,
    host: original.pid,
    generation: session.generation,
    pid: state.pid,
    text,
  };
  await fixture("checkpoint", checkpoint);
  for (const mode of ["old-version", "wrong-arch", "bad-signature", "offline", "interrupted"]) {
    await fixture(mode);
    let rejected = "";
    try {
      const found = await invoke<{ version: string }>("update_check");
      if (mode === "old-version") assert(!found.version, "Old update version was accepted");
      else if (["wrong-arch", "offline"].includes(mode))
        throw Error("Fixture unexpectedly found an update");
      else await download();
    } catch (error) {
      rejected = String(error);
    }
    if (mode === "bad-signature")
      assert(
        rejected === "DOWNLOAD_VERIFY",
        `Bad signature did not reach exact cryptographic rejection: ${rejected}`,
      );
    else if (mode === "wrong-arch" || mode === "offline")
      assert(rejected && !rejected.includes("unexpectedly"), `${mode} did not fail`);
    else assert(!rejected, `${mode}: ${rejected}`);
    await scene(mode, {
      realUpdaterSDK: true,
      mode,
      error: rejected || null,
      passed: true,
      sameHostAndGeneration: (await host()).pid === original.pid,
    });
  }
  await fixture("good");
  await invoke("update_check");
  await download();
  await invoke("editor_guard", { active: true });
  let protectedInstall = false;
  try {
    await invoke("update_install");
  } catch (error) {
    protectedInstall = String(error) === qa.editorGuardError;
  } finally {
    await invoke("editor_guard", { active: false });
  }
  assert(
    protectedInstall && (await fixture("context")).version === "0.2.4",
    "Actual updater bypassed editor guard",
  );
  await scene("editor-protected", {
    realInstallCommandRejected: true,
    simulatedDirtyEditorGuard: true,
    coreDraftRetained: (await draft(context, observe)).draft.text === text,
  });
  await invoke("database_guard", { id: "updates-simulated-sql-draft", dirty: true });
  let protectedDatabase = false;
  try {
    await invoke("update_install");
  } catch (error) {
    protectedDatabase = String(error) === qa.databaseGuardError;
  } finally {
    await invoke("database_guard", { id: "updates-simulated-sql-draft", dirty: false });
  }
  assert(
    protectedDatabase && (await fixture("context")).version === "0.2.4",
    "Actual updater bypassed database draft guard",
  );
  await scene("database-protected", {
    realInstallCommandRejected: true,
    simulatedDatabaseDraftGuard: true,
    sameHostPID: (await host()).pid === original.pid,
  });
  const rejectInstallation = async (expected: string) => {
    let rejected = false;
    try {
      await invoke("update_install");
    } catch (error) {
      rejected = String(error) === expected;
    }
    assert(rejected, "Actual signed installer bypassed an active operation guard");
    assert((await host()).pid === original.pid, "Rejected installation changed the host");
  };
  const transfer = (action: string) => invoke<{ busy: boolean }>("qa_update_transfer", { action });
  try {
    assert((await transfer("start")).busy, "Simulated transfer worker was not registered");
    await rejectInstallation(qa.transferGuardError);
    assert((await transfer("cancel")).busy, "Cancellation released an unfinished transfer");
    await rejectInstallation(qa.transferGuardError);
    await scene("transfer-protected", {
      realInstallCommandRejected: true,
      actualTransferRegistry: true,
      simulatedTransferWorker: true,
      cancelledWorkerRemainsProtectedUntilCompletion: true,
    });
  } finally {
    assert(!(await transfer("complete")).busy, "Completed transfer remained busy");
  }
  const databaseFixture = await invoke<{ port: number; password: string }>("qa_database_fixture");
  await invoke("database_components", { action: "install", id: "postgresql" });
  const database = await invoke<{ handle: string }>("database_connect", {
    config: {
      id: crypto.randomUUID(),
      name: "Updater PostgreSQL QA",
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
  const databaseRequest = (request: unknown) =>
    invoke<{ rows: string[][] }>("database_request", { handle: database.handle, request });
  try {
    const pending = databaseRequest({ op: "query", sql: "SELECT pg_sleep(8)", offset: 0 });
    let completed = false;
    const observed = pending.finally(() => {
      completed = true;
    });
    try {
      await pause(250);
      assert(!completed, "Long query completed before the updater guard observation");
      await rejectInstallation(qa.databaseGuardError);
      assert(!completed, "Database guard was not observed during the query");
      await scene("database-query-protected", {
        realInstallCommandRejected: true,
        actualPostgreSQLQuery: true,
      });
    } finally {
      await observed;
    }
    await databaseRequest({ op: "writable", enabled: true });
    await databaseRequest({
      op: "query",
      sql: "UPDATE qa_exact SET note='UNCOMMITTED_UPDATE_QA' WHERE id=1",
      offset: 0,
    });
    await rejectInstallation(qa.databaseGuardError);
    await scene("database-transaction-protected", {
      realInstallCommandRejected: true,
      actualUncommittedTransaction: true,
    });
    await databaseRequest({ op: "rollback" });
    await databaseRequest({ op: "writable", enabled: false });
    const result = await databaseRequest({
      op: "query",
      sql: "SELECT note FROM qa_exact WHERE id=1",
      offset: 0,
    });
    assert(
      result.rows[0]?.[0] === "ORIGINAL_DATABASE_TEXT",
      "Rejected update lost the database rollback",
    );
  } finally {
    await invoke("database_disconnect", { handle: database.handle, discard: true });
  }
  const settings = await until(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]:not(:disabled)'),
    "settings",
  );
  settings.click();
  await click("Software update");
  await click("Check for updates");
  await until(
    () =>
      [...document.querySelectorAll(".settings-content button")].some(
        (value) => value.textContent === "Download update",
      ),
    "manual update found",
  );
  await scene("manual-found", { realManualCheck: true, defaultAutomaticOff: true });
  await fixture("automatic");
  const automatic = await until(
    () =>
      document.querySelector<HTMLInputElement>(
        '.settings-content input[role="switch"]:not(:disabled)',
      ),
    "automatic update opt-in",
  );
  assert(!automatic.checked, "Automatic preference unexpectedly enabled");
  automatic.click();
  await until(
    () => document.querySelector(".update-install-dialog[open]"),
    "actual automatic download and confirmation",
  );
  await click("Cancel", ".update-install-dialog button");
  automatic.click();
  let automaticOptOutRetries = 0;
  await until(async () => {
    const retry = [...document.querySelectorAll<HTMLButtonElement>(".settings-dialog button")].find(
      (value) => value.textContent?.trim() === "Retry saving settings" && !value.disabled,
    );
    if (retry) {
      assert(automaticOptOutRetries < 3, "Automatic opt-out repeatedly failed to save");
      retry.click();
      automaticOptOutRetries++;
      await pause(200);
    }
    try {
      return !((await observe("snapshot.read")) as unknown as typeof snapshot).document.settings
        .automaticUpdates;
    } catch (error) {
      if ((error as { code?: string }).code === "WRITER_BUSY") return false;
      throw error;
    }
  }, "durable automatic opt-out");
  assert(
    !document.querySelector(".update-install-dialog[open]"),
    "Cancel retained installation confirmation",
  );
  await scene("automatic-cancelled", {
    realAutomaticDownloadAndConfirmation: true,
    actualCancelButton: true,
    automaticOptOut: true,
    automaticOptOutRetries,
    coreDraftRetained: (await draft(context, observe)).draft.text === text,
  });
  await click("Install and restart");
  await until(
    () => document.querySelector(".update-install-dialog[open]"),
    "explicit manual installation confirmation",
  );
  await click("Install now", ".update-install-dialog button");
}
