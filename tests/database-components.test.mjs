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
  let failure = "DB_COMPONENT_HASH";
  const handlers = new Map();
  mockIPC((command, args) => {
    if (command === "plugin:event|listen") {
      handlers.set(args.event, args.handler);
      return handlers.size;
    }
    if (command !== "database_components") return null;
    calls.push(args);
    if (args.action === "install") {
      if (failure) throw new Error(failure);
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
    failure = null;
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
    const runtime = state.items.find((item) => item.id === "runtime");
    runtime.external = true;
    state.java = "/local Java/bin/java";
    state.items.find((item) => item.id === "mysql").installed = false;
    await render("mysql");
    await click("Refresh");
    const runtimeRow = () =>
      [...document.querySelectorAll(".database-component-row")].find(
        (row) => row.querySelector("strong").textContent === "Java runtime",
      );
    assert.match(runtimeRow().textContent, /Using local Java · Ready/);
    assert.equal(runtimeRow().querySelectorAll("button").length, 0);
    assert.doesNotMatch(runtimeRow().textContent, /example.com|KB/);
    assert.match(button("Install required components").textContent, /1 KB/);
    const before = calls.filter((call) => call.action === "install").length;
    await click("Install required components");
    assert.deepEqual(
      calls
        .filter((call) => call.action === "install")
        .slice(before)
        .map((call) => call.id),
      ["mysql"],
    );
    state.java = null;
    runtime.external = false;
    runtime.installed = false;
    runtime.downloaded = 500;
    await click("Refresh");
    assert.match(
      document.querySelector("section").textContent,
      /No working Java 17 or newer was detected/,
    );
    assert.match(runtimeRow().textContent, /Downloaded 1 KB/);
    assert.ok(button("Resume download"));
    failure = "DB_COMPONENT_DOWNLOAD";
    await click("Resume download");
    assert.match(document.querySelector('[role="alert"]').textContent, /progress was kept/);
    assert.ok(button("Resume download"));
    await act(async () => setUiLanguage("zh-Hans"));
    assert.match(document.querySelector("section").textContent, /未检测到可用的 Java 17/);
    assert.ok(button("继续下载"));
    failure = null;
    await click("继续下载");
    assert.equal(calls.filter((call) => call.action === "install").at(-1).id, "runtime");
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
