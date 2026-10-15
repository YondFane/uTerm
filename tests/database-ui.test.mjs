import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("database workbench confirms writes, retains failed SQL and keeps hidden connections", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    plugins: [
      {
        name: "database-test-editor",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/FileEditor")) return "\0database-editor";
        },
        load(id) {
          if (id === "\0database-editor")
            return "export function CodeEditor(props) { globalThis.databaseEditorProps = props; return null; }";
        },
      },
    ],
  });
  const { DatabaseWorkspace } = await server.ssrLoadModule("/src/components/DatabaseWorkspace.tsx");
  const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
  const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
  localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
  const config = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "MySQL QA",
    kind: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "",
    username: "qa",
    tls: true,
    ca_file: "",
    credential_id: null,
  };
  const calls = [];
  let failQuery = false;
  let suspend = false;
  let rejectPending;
  let cellReads = 0;
  const binaryCell = {
    get binary() {
      cellReads++;
      return "YmluYXJ5";
    },
    truncated: false,
  };
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "database_connect") return { handle: "database-qa", info: { version: "QA" } };
    if (command === "database_disconnect" && rejectPending) {
      rejectPending(new Error("DB_DISCONNECTED"));
      rejectPending = null;
    }
    if (command === "database_request") {
      if (args.request.op === "query" && suspend)
        return new Promise((resolve, reject) => {
          rejectPending = reject;
        });
      if (args.request.op === "query" && failQuery) throw new Error(String(failQuery));
      if (args.request.op === "query")
        return { columns: [{ name: "value", type: "BINARY" }], rows: [[binaryCell]] };
      if (args.request.op === "browse" && args.request.view === "catalogs")
        return {
          columns: [{ name: "TABLE_CAT", type: "VARCHAR" }],
          rows: [["metadata_db"], ["information_schema"]],
        };
      if (args.request.op === "browse" && args.request.view === "table")
        return {
          columns: [{ name: "preview", type: "VARCHAR" }],
          rows: [["table data"]],
          more: args.request.offset === 0,
        };
      if (args.request.op === "browse" && args.request.view === "columns")
        return { columns: [{ name: "COLUMN_NAME", type: "VARCHAR" }], rows: [["id"]] };
      if (args.request.op === "browse" && args.request.view === "tables")
        return {
          columns: [
            { name: "TABLE_NAME", type: "VARCHAR" },
            { name: "TABLE_CAT", type: "VARCHAR" },
          ],
          rows: [["qa_table", "metadata_db"]],
        };
      if (args.request.op === "writable") return { writable: args.request.enabled };
      return { columns: [], rows: [], pending: false };
    }
    return null;
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const render = (active) =>
    act(async () =>
      root.render(
        React.createElement(
          SettingsProvider,
          null,
          React.createElement(DatabaseWorkspace, { config, active, password: "" }),
        ),
      ),
    );
  const button = (text) =>
    [...document.querySelectorAll("button")].find((button) => button.textContent === text);
  const click = (text) => act(async () => button(text).click());
  try {
    await render(true);
    assert.equal(document.querySelector(".database-query-menu"), null);
    for (const text of ["Copy SQL", "Discard SQL changes"])
      assert.ok(button(text).closest(".database-query-actions"));
    await click("Connect");
    assert.ok(button("Disconnect"));
    const editorDeadline = Date.now() + 5000;
    while (!globalThis.databaseEditorProps && Date.now() < editorDeadline)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.ok(globalThis.databaseEditorProps, "The lazy SQL editor must finish loading");
    await click("Execute SQL");
    const reads = cellReads;
    assert.ok(reads > 0);
    await act(async () => globalThis.databaseEditorProps.change("SELECT 'draft'"));
    assert.equal(cellReads, reads, "Editing SQL must not rerender unchanged result cells");
    await act(async () =>
      document.querySelector('.database-tree-scope[title="metadata_db"]').click(),
    );
    await click("qa_table");
    const menu = document.querySelector(".database-object-menu");
    await act(async () => menu.querySelector("summary").click());
    assert.equal(menu.open, true);
    await act(async () =>
      menu
        .querySelector("div")
        .dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true })),
    );
    assert.equal(menu.open, true);
    await act(async () =>
      button("Copy SQL").dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true })),
    );
    assert.equal(menu.open, false);
    await act(async () => menu.querySelector("summary").click());
    await act(async () => {
      menu.querySelector("summary").focus();
      menu.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(menu.open, false);
    assert.equal(document.activeElement, menu.querySelector("summary"));
    assert.equal(globalThis.databaseEditorProps.document.text, "SELECT 'draft'");
    const originalResult = document.querySelector(".database-results td").textContent;
    await act(async () =>
      button("qa_table").dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })),
    );
    assert.equal(document.querySelector(".database-results td").textContent, "table data");
    assert.equal(globalThis.databaseEditorProps.document.text, "SELECT 'draft'");
    await click("Structure");
    assert.equal(document.querySelector(".database-results td").textContent, "id");
    await click("Data");
    await click("Next page");
    assert.equal(
      calls.filter((call) => call.args?.request?.view === "table").at(-1).args.request.offset,
      200,
    );
    await act(async () => document.querySelector('[role="tab"]').click());
    assert.equal(document.querySelector(".database-results td").textContent, originalResult);
    await click("Generate SELECT");
    await click("Cancel");
    assert.equal(globalThis.databaseEditorProps.document.text, "SELECT 'draft'");
    await click("Generate SELECT");
    await click("Confirm");
    assert.equal(
      globalThis.databaseEditorProps.document.text,
      "SELECT * FROM `metadata_db`.`qa_table`",
    );
    const checkbox = [...document.querySelectorAll('input[type="checkbox"]')][0];
    assert.equal(checkbox.checked, false);
    await act(async () => checkbox.click());
    await act(async () => globalThis.databaseEditorProps.change("SET @qa_value = 1"));
    const before = calls.filter((call) => call.args?.request?.op === "query").length;
    await click("Execute SQL");
    assert.equal(calls.filter((call) => call.args?.request?.op === "query").length, before);
    assert.equal(document.querySelector(".database-confirm-dialog").open, true);
    failQuery = "DB_SQL:1064:42000";
    await click("Confirm");
    assert.match(document.querySelector('[role="alert"]').textContent, /1064/);
    assert.equal(globalThis.databaseEditorProps.document.text, "SET @qa_value = 1");
    assert.equal(button("Commit transaction").disabled, false);
    assert.equal(checkbox.disabled, true);
    const transactions = calls.filter((call) =>
      ["commit", "rollback"].includes(call.args?.request?.op),
    ).length;
    await click("View data");
    await click("Structure");
    assert.equal(
      calls.filter((call) => ["commit", "rollback"].includes(call.args?.request?.op)).length,
      transactions,
    );
    assert.equal(button("Commit transaction").disabled, false);
    await act(async () => document.querySelector('[role="tab"]').click());
    await click("Roll back transaction");
    await click("Confirm");
    assert.equal(button("Commit transaction").disabled, true);
    const disconnects = calls.filter((call) => call.command === "database_disconnect").length;
    await render(false);
    assert.equal(document.querySelector('section[aria-label="Database workbench"]').hidden, true);
    assert.equal(
      calls.filter((call) => call.command === "database_disconnect").length,
      disconnects,
    );
    assert.equal(globalThis.databaseEditorProps.document.text, "SET @qa_value = 1");
    assert.ok(calls.some((call) => call.command === "database_guard" && call.args.dirty));
    await render(true);
    const revision = globalThis.databaseEditorProps.document.id;
    await click("Discard SQL changes");
    await click("Confirm");
    assert.equal(globalThis.databaseEditorProps.document.text, "SELECT 1");
    assert.notEqual(globalThis.databaseEditorProps.document.id, revision);
    await act(async () => checkbox.click());
    failQuery = false;
    suspend = true;
    await click("Execute SQL");
    assert.ok(button("Cancel query"));
    await click("Cancel query");
    assert.match(document.querySelector('[role="alert"]').textContent, /cancelled.*closed/i);
    assert.ok(button("Connect"));
    assert.equal(document.querySelector(".database-results td"), null);
    suspend = false;
    await click("Connect");
    failQuery = "DB_TIMEOUT";
    await click("Execute SQL");
    assert.ok(button("Connect"));
    assert.equal(button("Disconnect"), undefined);
    assert.match(document.querySelector('[role="alert"]').textContent, /timed out.*closed/i);
    assert.equal(globalThis.databaseEditorProps.document.text, "SELECT 1");
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.databaseEditorProps;
  }
});
