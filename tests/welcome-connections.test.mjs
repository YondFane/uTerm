import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("welcome connection actions follow visibility and open the existing dialogs without changing profiles", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLDialogElement",
    "Node",
    "localStorage",
  ])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.isTauri = true;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
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
        name: "welcome-test-renderers",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/TerminalWorkspace") || id.endsWith("/DeferredFileEditor"))
            return "\0welcome:" + id.split("/").at(-1);
        },
        load(id) {
          if (id === "\0welcome:TerminalWorkspace")
            return "export function TerminalWorkspace() { return null; }";
          if (id === "\0welcome:DeferredFileEditor")
            return "export function DeferredFileEditor() { return null; }";
        },
      },
    ],
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    const { App } = await server.ssrLoadModule("/src/App.tsx");
    const { SettingsProvider, useSettings } = await server.ssrLoadModule(
      "/src/lib/SettingsContext.tsx",
    );
    const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
    const { emptyWorkspace, workspaceKey } = await server.ssrLoadModule("/src/lib/workspace.ts");
    const workspace = emptyWorkspace();
    localStorage.setItem(workspaceKey, JSON.stringify(workspace));
    localStorage.setItem(
      settingsKey,
      JSON.stringify({ ...defaults, sidebarStyle: "classic", language: "en" }),
    );
    const calls = [];
    let resolveRuntime;
    let controlReady;
    mockIPC((command) => {
      calls.push(command);
      if (command === "control_wait")
        return new Promise((resolve) => {
          controlReady = resolve;
        });
      if (command === "control_poll") return { id: "qa-control", method: "status", params: {} };
      if (command === "runtime_info")
        return new Promise((resolve) => {
          resolveRuntime = resolve;
        });
      if (["local_session_list", "ssh_session_list"].includes(command))
        return { sessions: [], closed: [] };
      if (command === "update_status") return { enabled: false, version: "", downloaded: false };
      if (command === "ssh_info") return { available: true, aliases: [] };
      return null;
    });
    let settings;
    function Probe() {
      settings = useSettings();
      return null;
    }
    await act(async () =>
      root.render(
        React.createElement(
          SettingsProvider,
          null,
          React.createElement(Probe),
          React.createElement(App),
        ),
      ),
    );
    const buttons = () => [...document.querySelectorAll(".welcome-connections button")];
    const names = ["Add SSH connection", "Add Redis connection", "Add database connection"];
    assert.deepEqual(
      buttons().map((button) => button.textContent),
      names,
    );
    assert.ok(buttons().every((button) => button.disabled));
    await act(async () =>
      resolveRuntime({
        platform: "windows",
        architecture: "x86_64",
        version: "test",
        home: "/qa",
        agents: [],
        agent_definitions: [],
        debug: true,
        chat_directory: "/qa/chats",
      }),
    );
    assert.ok(buttons().every((button) => !button.disabled));
    for (let mask = 0; mask < 8; mask++) {
      await act(async () =>
        settings.save(
          {
            ...settings.settings,
            showSshConnections: !!(mask & 1),
            showRedisConnections: !!(mask & 2),
            showDatabaseConnections: !!(mask & 4),
          },
          false,
        ),
      );
      assert.deepEqual(
        buttons().map((button) => button.textContent),
        names,
      );
      assert.equal(document.querySelectorAll(".welcome-actions > button").length, 3);
    }
    const hiddenConnections = {
      showSshConnections: false,
      showRedisConnections: false,
      showDatabaseConnections: false,
    };
    await act(async () => settings.save({ ...settings.settings, ...hiddenConnections }, false));
    assert.deepEqual(
      buttons().map((button) => button.textContent),
      names,
    );
    assert.equal(document.querySelectorAll(".sidebar-rail-items button").length, 5);
    for (const [name, value] of Object.entries(hiddenConnections))
      assert.equal(settings.settings[name], value);
    const saved = localStorage.getItem(workspaceKey);
    for (const language of ["en", "zh-Hans"]) {
      await act(async () => settings.save({ ...settings.settings, language }, false));
      const expected =
        language === "en" ? names : ["添加 SSH 连接", "添加 Redis 连接", "添加数据库连接"];
      assert.deepEqual(
        buttons().map((button) => button.textContent),
        expected,
      );
      for (const name of expected) {
        await act(async () =>
          buttons()
            .find((button) => button.textContent === name)
            .click(),
        );
        assert.equal(document.querySelectorAll("dialog[open]").length, 1);
        assert.equal(document.querySelector("dialog[open] h2").textContent, name);
        const cancel = [...document.querySelectorAll("dialog[open] button")].find(
          (button) => button.textContent === (language === "en" ? "Cancel" : "取消"),
        );
        await act(async () => cancel.click());
        assert.equal(document.querySelector("dialog[open]"), null);
        assert.equal(localStorage.getItem(workspaceKey), saved);
      }
    }
    assert.ok(
      !calls.some((command) =>
        ["ssh_configure_auth", "redis_connect", "database_connect", "create_session"].includes(
          command,
        ),
      ),
    );
    assert.equal(calls.filter((command) => command === "control_wait").length, 1);
    assert.equal(calls.includes("control_poll"), false);
    await act(async () => controlReady(true));
    assert.equal(calls.filter((command) => command === "control_poll").length, 1);
    assert.equal(calls.filter((command) => command === "control_reply").length, 1);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.isTauri;
  }
});
