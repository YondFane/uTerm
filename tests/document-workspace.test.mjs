import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("document workbenches retain drafts, confirm writes, preserve exact JSON and guard target changes", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { DocumentWorkspace } = await server.ssrLoadModule("/src/components/DocumentWorkspace.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const calls = [];
  let conflict = true;
  const exact =
    '{"_id":{"$oid":"507f1f77bcf86cd799439011"},"large":{"$numberLong":"9223372036854775807"}}';
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "database_connect") return { handle: "documents-qa" };
    if (command === "database_export_result") return true;
    if (command === "database_request") {
      if (["databases", "collections"].includes(args.request.action)) return { names: ["qa"] };
      if (args.request.action === "query")
        return {
          documents: [
            {
              value: exact,
              identity: '{"_id":{"$oid":"507f1f77bcf86cd799439011"}}',
              version: "[3,1]",
            },
          ],
          more: true,
        };
      if (args.request.action === "replace" && conflict) throw new Error("DB_DOCUMENT_CONFLICT");
      return { affected: 1 };
    }
    return null;
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const config = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Documents QA",
    kind: "mongodb",
    host: "127.0.0.1",
    port: 27017,
    database: "qa",
    username: "",
    tls: false,
    ca_file: "",
    credential_id: null,
  };
  const render = (active = true) =>
    act(async () =>
      root.render(React.createElement(DocumentWorkspace, { config, active, password: "" })),
    );
  const button = (label) =>
    [...document.querySelectorAll("button")].find((item) => item.textContent === label);
  const click = (label) => act(async () => button(label).click());
  const input = (element, value) =>
    act(async () => {
      const prototype =
        element.tagName === "TEXTAREA"
          ? dom.window.HTMLTextAreaElement.prototype
          : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  try {
    await render();
    await click("Connect");
    await input(document.querySelector('input[aria-label="Collection"]'), "docs");
    const query = '{"filter":{"large":{"$numberLong":"9223372036854775807"}}}';
    await input(document.querySelector('textarea[aria-label="Query JSON"]'), query);
    await click("Run query");
    assert.equal(
      calls.find((call) => call.args?.request?.action === "query").args.request.query,
      query,
    );
    await click("Next page");
    assert.equal(
      calls.filter((call) => call.args?.request?.action === "query").at(-1).args.request.offset,
      50,
    );
    await input(document.querySelector('textarea[aria-label="Query JSON"]'), '{"filter":{}}');
    assert.equal(button("Next page").disabled, true);
    assert.equal(button("Previous page").disabled, true);
    await click("Next page");
    assert.equal(calls.filter((call) => call.args?.request?.action === "query").length, 2);
    await click("Run query");
    assert.equal(
      calls.filter((call) => call.args?.request?.action === "query").at(-1).args.request.offset,
      0,
    );
    assert.equal(button("Next page").disabled, false);
    await input(document.querySelector('textarea[aria-label="Query JSON"]'), query);
    await click("Run query");
    await act(async () => document.querySelector(".document-result").click());
    assert.equal(document.querySelector('textarea[aria-label="Document JSON"]').readOnly, true);
    await act(async () => document.querySelector('input[type="checkbox"]').click());
    await input(
      document.querySelector('textarea[aria-label="Document JSON"]'),
      exact.replace("9223372036854775807", "9223372036854775806"),
    );
    await click("Replace document");
    assert.equal(
      calls.some((call) => call.args?.request?.action === "replace"),
      false,
    );
    await click("Confirm");
    assert.match(document.querySelector('[role="alert"]').textContent, /document changed/);
    assert.match(
      document.querySelector('textarea[aria-label="Document JSON"]').value,
      /9223372036854775806/,
    );
    await render(false);
    assert.equal(document.querySelector("section").hidden, true);
    assert.equal(
      calls.some((call) => call.command === "database_disconnect"),
      false,
    );
    await render();
    conflict = false;
    await click("Replace document");
    await click("Confirm");
    const write = calls.filter((call) => call.args?.request?.action === "replace").at(-1)
      .args.request;
    assert.equal(write.confirmed, true);
    assert.equal(write.original, exact);
    assert.equal(document.querySelector('textarea[aria-label="Document JSON"]'), null);
    await click("New document");
    await input(document.querySelector('textarea[aria-label="Document JSON"]'), '{"new":true}');
    await input(document.querySelector('input[aria-label="Collection"]'), "other");
    assert.equal(document.querySelector('input[aria-label="Collection"]').value, "docs");
    await click("Cancel");
    assert.equal(
      document.querySelector('textarea[aria-label="Document JSON"]').value,
      '{"new":true}',
    );
    await click("Save JSON");
    assert.equal(calls.find((call) => call.command === "database_export_result").args.data, query);
    assert.ok(calls.some((call) => call.command === "database_guard" && call.args.dirty));
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
