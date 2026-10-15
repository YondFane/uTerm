import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("database components install only chosen dependencies, stop on verification failure and support global cancellation", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { DatabaseComponents } = await server.ssrLoadModule(
    "/src/components/DatabaseComponents.tsx",
  );
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const state = {
    java: null,
    busy: false,
    items: ["runtime", "mysql", "postgresql", "oracle"].map((id) => ({
      id,
      installed: false,
      size: 1000,
      version: "QA",
      source: "https://example.com/component",
    })),
  };
  const calls = [];
  let fail = true;
  const handlers = new Map();
  mockIPC((command, args) => {
    if (command === "plugin:event|listen") {
      handlers.set(args.event, args.handler);
      return handlers.size;
    }
    if (command !== "database_components") return null;
    calls.push(args);
    if (args.action === "install") {
      if (fail) throw new Error("DB_COMPONENT_HASH");
      state.items.find((item) => item.id === args.id).installed = true;
    }
    if (args.action === "cancel") state.busy = false;
    return structuredClone(state);
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const render = (kind) =>
    act(async () => root.render(React.createElement(DatabaseComponents, { selectedKind: kind })));
  const button = (prefix) =>
    [...document.querySelectorAll("button")].find((button) =>
      button.textContent.startsWith(prefix),
    );
  const click = (prefix) => act(async () => button(prefix).click());
  try {
    await render("mysql");
    assert.match(button("Install required components").textContent, /2 KB/);
    assert.match(document.querySelector("section").textContent, /connection engine is built in/);
    assert.equal(
      calls.some((call) => call.action === "install"),
      false,
    );
    await click("Install required components");
    assert.deepEqual(
      calls.filter((call) => call.action === "install").map((call) => call.id),
      ["runtime"],
    );
    assert.match(document.querySelector('[role="alert"]').textContent, /verification failed/);
    assert.equal(
      state.items.some((item) => item.installed),
      false,
    );
    fail = false;
    await click("Install required components");
    assert.deepEqual(
      calls.filter((call) => call.action === "install").map((call) => call.id),
      ["runtime", "runtime", "mysql"],
    );
    await render("oracle");
    await click("Install required components");
    assert.equal(calls.filter((call) => call.action === "install").at(-1).id, "oracle");
    assert.equal(
      calls.some((call) => call.action === "install" && call.id === "postgresql"),
      false,
    );
    assert.equal(
      calls.some((call) => call.id === "engine"),
      false,
    );
    state.busy = true;
    await click("Refresh");
    assert.ok(button("Cancel installation"));
    const statusReads = calls.filter((call) => call.action === "status").length;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
    assert.equal(calls.filter((call) => call.action === "status").length, statusReads);
    await click("Cancel installation");
    assert.ok(calls.some((call) => call.action === "cancel"));
    await act(async () =>
      window.__TAURI_INTERNALS__.runCallback(handlers.get("database-components-changed"), {
        payload: null,
      }),
    );
    assert.equal(button("Cancel installation"), undefined);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
