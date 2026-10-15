import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Agent switches gate creation, persist, preserve sessions and report storage failures", async () => {
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
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const server = await createServer({
    configFile: false,
    plugins: [
      {
        name: "agent-test-renderers",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/TerminalWorkspace") || id.endsWith("/DeferredFileEditor"))
            return "\0agent:" + id.split("/").at(-1);
        },
        load(id) {
          if (id === "\0agent:TerminalWorkspace")
            return "export function TerminalWorkspace() { return null; }";
          if (id === "\0agent:DeferredFileEditor")
            return "export function DeferredFileEditor() { return null; }";
        },
      },
    ],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  mockIPC((command) => {
    if (command === "runtime_info")
      return {
        platform: "macos",
        home: "/test",
        agents: ["claude", "codex", "custom"],
        agent_definitions: [{ id: "custom", name: "Custom", program: "custom", arguments: [] }],
        version: "test",
        debug: true,
        chat_directory: "/test",
      };
    if (command === "local_session_list") return { sessions: [], closed: [] };
    if (command === "project_worktrees") return [];
    if (command === "update_status") return { enabled: false, version: "", downloaded: false };
    if (command === "git_branches") return { current: "main", local: ["main"] };
    if (command === "files_list") return { entries: [], partial: false, skipped: 0 };
    if (command === "autostart_configure") return false;
    return null;
  });
  let root;
  const originalSetItem = dom.window.Storage.prototype.setItem;
  try {
    const load = (path) => server.ssrLoadModule("/src/" + path);
    const { App } = await load("App.tsx");
    const { SettingsProvider, useSettings } = await load("lib/SettingsContext.tsx");
    const { defaults, settingsKey } = await load("lib/settings.ts");
    const { workspaceKey, emptyWorkspace } = await load("lib/workspace.ts");
    localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
    const workspace = emptyWorkspace();
    workspace.projects = [
      {
        id: "project",
        name: "Test",
        directory: "/test",
        workspaceId: workspace.selectedWorkspace,
        sessions: [],
        worktrees: [],
      },
    ];
    workspace.selectedProject = "project";
    localStorage.setItem(workspaceKey, JSON.stringify(workspace));
    let prefs;
    function Harness() {
      prefs = useSettings();
      return React.createElement(App);
    }
    const { createRoot } = await import("react-dom/client");
    const render = async () => {
      root = createRoot(document.getElementById("root"));
      await act(async () =>
        root.render(React.createElement(SettingsProvider, null, React.createElement(Harness))),
      );
    };
    const click = (node) => {
      assert.ok(node);
      return act(async () => node.click());
    };
    const button = (text) =>
      [...document.querySelectorAll("button")].find((node) => node.textContent === text);
    const toggle = (name) => document.querySelector(`input[aria-label="Enable ${name}"]`);
    const shortcut = () =>
      act(async () =>
        window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "n",
            code: "KeyN",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    const sessions = () => JSON.parse(localStorage.getItem(workspaceKey)).projects[0].sessions;
    await render();
    assert.equal(document.querySelector('[title="New Codex session"]'), null);
    await shortcut();
    assert.equal(sessions().length, 0);
    await click(document.querySelector('button[aria-label="Settings"]'));
    await click(button("Agent"));
    assert.equal(toggle("Codex").checked, false);
    assert.equal(toggle("Grok").disabled, true);
    await click(toggle("Claude"));
    assert.ok(document.querySelector('[title="New Claude session"]'));
    assert.equal(document.querySelector('[title="New Codex session"]'), null);
    assert.deepEqual(JSON.parse(localStorage.getItem(settingsKey)).enabledAgents, ["claude"]);
    await click(button("Workspace"));
    const agentSelect = [...document.querySelectorAll("label")]
      .find((node) => node.textContent.includes("Agent for new chats"))
      .querySelector("select");
    assert.equal(agentSelect.value, "claude");
    assert.equal(agentSelect.options.length, 1);
    await click(document.querySelector('button[aria-label="Close settings"]'));
    await shortcut();
    assert.equal(sessions().length, 1);
    assert.equal(sessions()[0].agent, "claude");
    await click(document.querySelector('button[aria-label="Settings"]'));
    await click(button("Agent"));
    const saved = localStorage.getItem(settingsKey);
    dom.window.Storage.prototype.setItem = function (key, value) {
      if (key === settingsKey) throw new Error("storage unavailable");
      return originalSetItem.call(this, key, value);
    };
    await click(toggle("Claude"));
    assert.equal(toggle("Claude").checked, true);
    assert.equal(localStorage.getItem(settingsKey), saved);
    assert.match(
      document.querySelector('.agent-settings [role="alert"]').textContent,
      /storage unavailable/,
    );
    dom.window.Storage.prototype.setItem = originalSetItem;
    await click(toggle("Claude"));
    assert.equal(document.querySelector('[title="New Claude session"]'), null);
    assert.equal(sessions().length, 1);
    await click(toggle("Custom"));
    assert.ok(document.querySelector('[title="New Custom session"]'));
    await act(async () => prefs.save({ ...prefs.settings, language: "zh-Hans" }, true));
    assert.ok(document.querySelector('input[aria-label="启用 Custom"]').checked);
    await act(async () => root.unmount());
    root = null;
    await render();
    assert.ok(document.querySelector('[title="新建 Custom 会话"]'));
    assert.equal(document.querySelector('[title="新建 Claude 会话"]'), null);
    assert.equal(sessions().length, 1);
  } finally {
    dom.window.Storage.prototype.setItem = originalSetItem;
    if (root) await act(async () => root.unmount());
    delete globalThis.isTauri;
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
