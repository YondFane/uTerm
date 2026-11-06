import { invoke } from "@tauri-apps/api/core";
import { databaseKinds, databasePorts, type DatabaseConfig } from "../lib/database";
import databaseFixtureJSON from "../../shared/fixtures/database-qa.json?raw";

const databaseFixture = JSON.parse(databaseFixtureJSON) as {
  exactSQL: string;
  exactInteger: string;
  exactDecimal: string;
  textMarker: string;
};

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
async function until<T>(read: () => T | Promise<T>, description: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause(100);
  }
  throw Error(`Database QA timed out: ${description}`);
}
async function click(label: string, scope: ParentNode = document) {
  const control = await until(
    () =>
      [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === label && !item.disabled,
      ),
    label,
  );
  control.click();
  await pause(100);
}
async function field(label: string, value: string) {
  const input = await until(
    () =>
      [...document.querySelectorAll(".database-dialog[open] label")]
        .find((item) => item.textContent?.trim().startsWith(label))
        ?.querySelector<HTMLInputElement | HTMLSelectElement>("input, select"),
    label,
  );
  const prototype =
    input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(
    new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
  await pause(100);
}

export async function runDatabase(
  scene: (name: string, checks: unknown) => Promise<void>,
  snapshot: () => Promise<unknown>,
) {
  const fixture = await invoke<{ port: number; password: string; savedText: string }>(
    "qa_database_fixture",
  );
  const component = await invoke<{ items: { id: string; installed: boolean }[] }>(
    "database_components",
    {
      action: "install",
      id: "postgresql",
    },
  );
  assert(
    component.items.some((item) => item.id === "postgresql" && item.installed),
    "Verified PostgreSQL JDBC installation failed",
  );
  (
    await until(
      () => document.querySelector<HTMLButtonElement>('.sidebar-rail-button[aria-label="All"]'),
      "all sections",
    )
  ).click();
  for (const kind of databaseKinds) {
    (
      await until(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Add database connection"]'),
        "add profile",
      )
    ).click();
    await field("Database type", kind);
    await field("Name", `Tauri Database QA ${kind}`);
    await field("Host address", "127.0.0.1");
    await field("Port", String(kind === "postgresql" ? fixture.port : databasePorts[kind]));
    if (kind === "oracle") await field("Oracle service name", "FREEPDB1");
    else if (kind !== "elasticsearch") await field("Database name", "uterm_qa");
    if (kind === "mongodb") await field("Authentication database", "qa_auth");
    await field("Username", "uterm_qa");
    if (kind === "postgresql") await field("Password", fixture.password);
    const tls = [...document.querySelectorAll(".database-dialog[open] label")]
      .find((item) => item.textContent?.trim() === "Enable TLS")
      ?.querySelector<HTMLInputElement>("input");
    assert(tls, "TLS field missing");
    if (tls.checked) tls.click();
    await click("Save connection", document.querySelector(".database-dialog[open]")!);
    await until(() => !document.querySelector(".database-dialog[open]"), "saved profile");
  }
  const state = (await snapshot()) as {
    document: { workspace: { groups: { databaseConnections?: DatabaseConfig[] }[] } };
  };
  const profiles = state.document.workspace.groups
    .flatMap((group) => group.databaseConnections ?? [])
    .filter((item) => item.name.startsWith("Tauri Database QA "));
  assert(
    profiles.length === 5 &&
      databaseKinds.every((kind) => profiles.some((item) => item.kind === kind)),
    "Supported database profiles were lost",
  );
  assert(
    !JSON.stringify(state).includes(fixture.password) &&
      profiles.every((item) => item.credential_id === null),
    "Temporary password persisted",
  );
  assert(
    profiles.find((item) => item.kind === "oracle")?.database === "FREEPDB1",
    "Oracle service name changed",
  );
  assert(
    profiles.find((item) => item.kind === "mongodb")?.auth_source === "qa_auth",
    "MongoDB authentication database changed",
  );
  const config = profiles.find((item) => item.kind === "postgresql")!;
  const profile = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === config.name,
    );
  (await until(profile, "PostgreSQL profile")).click();
  const workspace = await until(() => {
    const selected = document.querySelector<HTMLElement>(".database-workspace:not([hidden])");
    return selected?.querySelector(".database-run") &&
      selected.querySelector(".database-connection-bar")?.textContent?.includes(`:${fixture.port}`)
      ? selected
      : null;
  }, "SQL workbench");
  await click("Connect", workspace);
  const ready = async () =>
    until(() => {
      const execute = workspace.querySelector<HTMLButtonElement>(".database-run");
      const editor = workspace.querySelector<HTMLElement>(
        '.database-sql-editor:not([hidden]) .cm-content[contenteditable="true"]',
      );
      if (!execute || execute.disabled || !editor || editor.getBoundingClientRect().width <= 0)
        return null;
      return editor;
    }, "editable SQL after catalog loading");
  const sql = async (text: string) => {
    const editor = await ready();
    editor.focus();
    assert(document.execCommand("selectAll", false), "SQL selection failed");
    assert(document.execCommand("insertText", false, text), "SQL insertion failed");
    await until(() => editor.textContent === text, "SQL editor text");
    await pause(100);
  };
  const dialog = () =>
    workspace.querySelector<HTMLDialogElement>("dialog.database-confirm-dialog[open]");
  const confirm = async () => {
    const value = await until(dialog, "SQL confirmation");
    await click("Confirm", value);
    await until(() => !value.open, "confirmation completed");
    await ready();
  };
  const editing = () =>
    [...workspace.querySelectorAll(".database-connection-bar label")]
      .find((item) => item.textContent?.trim() === "Allow editing")
      ?.querySelector<HTMLInputElement>("input");
  await ready();
  assert(editing() && !editing()!.checked, "Database must connect read-only");
  await scene("database-live-profiles", {
    supportedKinds: databaseKinds,
    profileSavedInCore: true,
    temporaryPasswordNotPersisted: true,
    defaultReadonly: true,
    verifiedDriverInstalled: true,
  });

  const exact = databaseFixture.exactSQL;
  await sql(exact);
  await click("Execute SQL", workspace);
  await until(
    () =>
      workspace
        .querySelector(".database-grid-container")
        ?.textContent?.includes("9223372036854775807") &&
      workspace
        .querySelector(".database-grid-container")
        ?.textContent?.includes("12345678901234567890.1234567890") &&
      workspace
        .querySelector(".database-grid-container")
        ?.textContent?.includes(databaseFixture.textMarker),
    "exact SQL result",
  );
  await scene("database-live-exact", {
    exactInteger: "9223372036854775807",
    exactDecimal: "12345678901234567890.1234567890",
    actualSQLExecuted: true,
    unicodeRetained: true,
  });

  const retainedEditor = await ready();
  const project = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.title.startsWith("Temporary QA project —"),
  );
  assert(project, "Temporary project missing");
  project.click();
  await until(() => workspace.hidden, "hide workbench");
  (await until(profile, "retained profile")).click();
  await until(() => !workspace.hidden, "reopen workbench");
  assert((await ready()) === retainedEditor, "Hidden workbench recreated its SQL editor");
  await invoke("qa_request_exit");
  const quit = await until(
    () =>
      [
        ...document.querySelectorAll<HTMLDialogElement>("dialog.database-confirm-dialog[open]"),
      ].find((item) => item.textContent?.includes("Return to workbench")),
    "actual quit protection",
  );
  await click("Return to workbench", quit);
  assert(retainedEditor.textContent === exact, "Cancelled quit discarded SQL draft");
  await scene("database-live-draft", {
    hiddenWorkbenchRetainedEditor: true,
    cancelledApplicationQuitRetainedDraftAndConnection: true,
  });

  await sql(`UPDATE qa_exact SET note='${fixture.savedText}' WHERE id=1`);
  await click("Execute SQL", workspace);
  await until(
    () =>
      workspace.querySelector('[role="alert"]')?.textContent?.toLowerCase().includes("read-only"),
    "read-only write rejection",
  );
  editing()!.click();
  await until(() => editing()?.checked && !editing()?.disabled, "explicit editing");
  await click("Execute SQL", workspace);
  const writeReview = await until(dialog, "write review");
  assert(
    writeReview.textContent?.includes(fixture.savedText),
    "Write review did not show actual SQL",
  );
  await click("Cancel", writeReview);
  assert(
    !workspace.querySelector('[role="status"]')?.textContent?.includes("Transaction open"),
    "Cancelled SQL opened a transaction",
  );
  await click("Execute SQL", workspace);
  await confirm();
  await until(() => workspace.textContent?.includes("Transaction open"), "pending transaction");
  await click("Disconnect", workspace);
  await click("Cancel", await until(dialog, "pending disconnect guard"));
  await click("Roll back transaction", workspace);
  await confirm();
  await until(() => !workspace.textContent?.includes("Transaction open"), "rollback");
  await click("Execute SQL", workspace);
  await confirm();
  await click("Commit transaction", workspace);
  await confirm();
  await until(() => !workspace.textContent?.includes("Transaction open"), "commit");
  await scene("database-live-transactions", {
    readonlyWriteRefused: true,
    cancelledWriteDidNotOpenTransaction: true,
    cancelledPendingDisconnectRetainedConnection: true,
    rollbackAndCommitCompleted: true,
  });

  const probe = await invoke<{ handle: string }>("database_connect", {
    config,
    password: fixture.password,
  });
  const active = async () => {
    const result = await invoke<{ rows: string[][] }>("database_request", {
      handle: probe.handle,
      request: {
        op: "query",
        sql: "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active' AND query LIKE '%qa_cancel_marker%'",
        offset: 0,
      },
    });
    return result.rows[0][0];
  };
  try {
    editing()!.click();
    await until(
      () => editing() && !editing()!.checked && !editing()!.disabled,
      "read-only before slow query",
    );
    await sql("SELECT pg_sleep(20) AS qa_cancel_marker");
    await click("Execute SQL", workspace);
    await until(async () => (await active()) === "1", "server observes actual running query");
    await click("Cancel query", workspace);
    await until(
      async () => (await active()) === "0",
      "cancelled query actually released on server",
    );
  } finally {
    await invoke("database_disconnect", { handle: probe.handle, discard: true });
  }
  await click("Connect", workspace);
  await ready();
  assert(!editing()!.checked, "Reconnect must reset read-only");
  await sql("SELECT note FROM qa_exact WHERE id=1");
  await click("Execute SQL", workspace);
  await until(
    () =>
      workspace.querySelector(".database-grid-container")?.textContent?.includes(fixture.savedText),
    "committed data after reconnect",
  );
  await scene("database-live-recovery", {
    serverObservedSlowQueryCancelled: true,
    temporaryPasswordReconnect: true,
    reconnectDefaultsReadonly: true,
    committedDataReread: true,
  });
  await click("Discard SQL changes", workspace);
  await confirm();
  await click("Disconnect", workspace);
  await until(
    () => workspace.querySelector('input[aria-label="Temporary password"]'),
    "disconnect",
  );
  await invoke("qa_request_exit");
}
