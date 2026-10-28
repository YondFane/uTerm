import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("App keeps navigation and footer controls visible when only the sidebar list collapses", async () => {
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
  dom.window.HTMLElement.prototype.setPointerCapture = function () {};
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
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
        name: "sidebar-visibility-renderers",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/TerminalWorkspace") || id.endsWith("/DeferredFileEditor"))
            return "\0sidebar-visibility:" + id.split("/").at(-1);
        },
        load(id) {
          if (id === "\0sidebar-visibility:TerminalWorkspace")
            return "export function TerminalWorkspace() { return null; }";
          if (id === "\0sidebar-visibility:DeferredFileEditor")
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
    const state = emptyWorkspace();
    state.projects = [
      {
        id: "project",
        name: "Project",
        directory: "D:/fixture",
        workspaceId: state.selectedWorkspace,
        sessions: [],
      },
    ];
    state.selectedProject = state.groups[0].selectedProject = "project";
    localStorage.setItem(workspaceKey, JSON.stringify(state));
    localStorage.setItem(
      settingsKey,
      JSON.stringify({ ...defaults, sidebarStyle: "classic", language: "en" }),
    );
    const calls = [];
    mockIPC((command, args) => {
      calls.push(command);
      if (command === "runtime_info")
        return {
          platform: "windows",
          home: "D:/fixture",
          agents: [],
          agent_definitions: [],
          version: "test",
          debug: true,
          chat_directory: "D:/fixture/chats",
        };
      if (command === "control_wait") return new Promise(() => {});
      if (["local_session_list", "ssh_session_list"].includes(command))
        return { sessions: [], closed: [] };
      if (command === "files_list") return { entries: [], partial: false, skipped: 0 };
      if (command === "git_branches") return { current: "release", local: ["release"], remote: [] };
      if (command === "git_snapshot")
        return { root: args.directory, branch: "release", references: ["release"], changes: [] };
      if (["project_worktrees", "directory_tools"].includes(command)) return [];
      if (command === "update_status") return { enabled: false, version: "", downloaded: false };
      if (command === "ssh_info") return { available: true, aliases: [] };
      return null;
    });
    let preferences;
    function Harness() {
      preferences = useSettings();
      return React.createElement(App);
    }
    await act(async () =>
      root.render(React.createElement(SettingsProvider, null, React.createElement(Harness))),
    );
    const savedWorkspace = localStorage.getItem(workspaceKey);
    const shell = () => document.querySelector(".app-shell");
    const sidebar = () => document.querySelector("#workspace-sidebar");
    const content = () => document.querySelector(".sidebar-main");
    const width = () => Number.parseFloat(shell().style.getPropertyValue("--sidebar-width"));
    const click = (selector) => act(async () => document.querySelector(selector).click());
    const save = (patch) =>
      act(async () => preferences.save({ ...preferences.settings, ...patch }, false));
    const separator = () => document.querySelector(".sidebar-resizer");
    const key = (code) =>
      act(async () =>
        separator().dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { bubbles: true, key: code }),
        ),
      );
    const pointer = (type, x) =>
      act(async () =>
        separator().dispatchEvent(
          new dom.window.MouseEvent(type, { bubbles: true, clientX: x, button: 0 }),
        ),
      );
    const collapsed = () => {
      assert.equal(sidebar().hidden, false);
      assert.equal(content().hidden, true);
      assert.equal(width(), 48);
      assert.equal(shell().classList.contains("sidebar-hidden"), false);
      assert.equal(shell().dataset.sidebarCollapsed, "true");
      assert.ok(document.querySelector(".sidebar-rail-footer .sidebar-add"));
      assert.ok(document.querySelector('.sidebar-rail [aria-label="Settings"]'));
      assert.ok(document.querySelector("main .sidebar-reopen"));
    };
    await click(".sidebar-add");
    assert.ok(document.querySelector('[aria-label="Add menu"]'));
    await act(async () =>
      window.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { code: "KeyB", ctrlKey: true, bubbles: true }),
      ),
    );
    assert.equal(sidebar().hidden, true);
    assert.equal(document.querySelector('[aria-label="Add menu"]'), null);
    assert.equal(width(), 0);
    assert.equal(shell().classList.contains("sidebar-hidden"), true);
    await save({ sidebarStyle: "navigation" });
    collapsed();
    await click('.sidebar-rail [aria-label="Projects and sessions"]');
    assert.equal(content().hidden, false);
    assert.equal(width(), 248);
    await click(".sidebar-toggle");
    collapsed();
    assert.equal(document.activeElement.getAttribute("aria-label"), "Projects and sessions");
    await click(".sidebar-add");
    assert.ok(document.querySelector('[aria-label="Add menu"]'));
    await act(async () =>
      window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })),
    );
    assert.equal(document.activeElement, document.querySelector(".sidebar-add"));
    for (const position of ["left", "right"]) {
      await save({ inspectorPosition: position });
      collapsed();
      assert.equal(shell().classList.contains("with-inspector"), true);
      assert.ok(document.querySelector(".app-shell > .file-panel"));
      assert.equal(shell().dataset.inspectorPosition, position);
    }
    for (const hidden of [false, true]) {
      await act(async () =>
        window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { code: "KeyB", ctrlKey: true, bubbles: true }),
        ),
      );
      assert.equal(content().hidden, hidden);
    }
    collapsed();
    await click("main .sidebar-reopen");
    await key("Home");
    collapsed();
    await key("ArrowRight");
    assert.equal(content().hidden, false);
    assert.ok(width() > 78);
    await key("Enter");
    assert.equal(width(), 248);
    await pointer("pointerdown", 248);
    await pointer("pointermove", 20);
    assert.ok(width() >= 48);
    await pointer("pointerup", 20);
    collapsed();
    await pointer("pointerdown", 48);
    await pointer("pointermove", 200);
    assert.equal(content().hidden, false);
    await pointer("pointercancel", 200);
    collapsed();
    await pointer("pointerdown", 48);
    await pointer("pointermove", 180);
    await pointer("pointerup", 180);
    assert.equal(content().hidden, false);
    assert.equal(width(), 180);
    await key("Home");
    await click('.sidebar-rail [aria-label="Projects and sessions"]');
    assert.equal(width(), 180);
    await key("Home");
    await save({ sidebarStyle: "classic" });
    assert.equal(sidebar().hidden, true);
    assert.equal(width(), 0);
    await click("main .sidebar-reopen");
    await pointer("pointerdown", 180);
    await pointer("pointermove", 31);
    await pointer("pointerup", 31);
    assert.equal(width(), 31);
    await save({ sidebarStyle: "navigation" });
    assert.equal(width(), 248);
    assert.equal(content().hidden, false);
    assert.equal(localStorage.getItem(workspaceKey), savedWorkspace);
    assert.equal(
      calls.some((command) =>
        [
          "create_session",
          "close_session",
          "ssh_connect",
          "redis_connect",
          "database_connect",
        ].includes(command),
      ),
      false,
    );
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.isTauri;
  }
});
