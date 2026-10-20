import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

test("native App actions retain session identity, guard dialogs and synchronize language and shortcuts", async () => {
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
        name: "native-menu-test-renderers",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/TerminalWorkspace") || id.endsWith("/DeferredFileEditor"))
            return "\0native-menu:" + id.split("/").at(-1);
        },
        load(id) {
          if (id === "\0native-menu:TerminalWorkspace")
            return "export function TerminalWorkspace(props) { globalThis.nativeMenuTerminal = props; return null; }";
          if (id === "\0native-menu:DeferredFileEditor")
            return "export function DeferredFileEditor() { return null; }";
        },
      },
    ],
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const snapshots = [];
  const installed = [];
  const closed = [];
  const external = [];
  let rid = 0;
  let delayNext = false;
  let release;
  let failNext = false;
  mockIPC(
    (command, args) => {
      if (command === "plugin:menu|new") {
        if (failNext) {
          failNext = false;
          throw Error("Menu denied");
        }
        const next = ++rid;
        snapshots.push({ rid: next, ...args.options });
        if (delayNext) {
          delayNext = false;
          return new Promise((resolve) => {
            release = () => resolve([next, args.options.id]);
          });
        }
        return [next, args.options.id];
      }
      if (command === "plugin:menu|set_as_app_menu") {
        installed.push(args.rid);
        return null;
      }
      if (command === "plugin:menu|get") return [++rid, args.id, "Submenu"];
      if (command === "plugin:resources|close") {
        closed.push(args.rid);
        return null;
      }
      if (command === "runtime_info")
        return {
          platform: "macos",
          architecture: "aarch64",
          version: "test",
          home: "/qa",
          agents: [],
          agent_definitions: [],
          debug: true,
          chat_directory: "/qa/chats",
        };
      if (["local_session_list", "ssh_session_list"].includes(command))
        return { sessions: [], closed: [] };
      if (command === "control_wait") return new Promise(() => {});
      if (command === "update_status") return { enabled: false, version: "", downloaded: false };
      if (command === "files_list") return { entries: [], partial: false, skipped: 0 };
      if (["project_worktrees", "ssh_tunnel_list"].includes(command)) return [];
      if (command === "ssh_info") return { available: true, aliases: [] };
      if (command === "autostart_configure") return false;
      if (command === "control_status")
        return { enabled: false, directory: "", endpoint: "", port: 0 };
      if (command === "open_external") external.push(args.url);
      return null;
    },
    { shouldMockEvents: true },
  );
  try {
    const { App } = await server.ssrLoadModule("/src/App.tsx");
    const { SettingsProvider, useSettings } = await server.ssrLoadModule(
      "/src/lib/SettingsContext.tsx",
    );
    const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
    const { emptyWorkspace, createWorkspaceGroup, workspaceKey } =
      await server.ssrLoadModule("/src/lib/workspace.ts");
    const workspace = emptyWorkspace();
    workspace.groups[0].terminals = [
      { id: "local-session", name: "Local", shell: "default", directory: "/qa" },
    ];
    const other = createWorkspaceGroup("other", "Other");
    other.terminals = [
      { id: "other-session", name: "Other shell", shell: "default", directory: "/qa/other" },
    ];
    workspace.groups.push(other);
    workspace.selectedSession = "local-session";
    localStorage.setItem(workspaceKey, JSON.stringify(workspace));
    localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
    let context;
    function Probe() {
      context = useSettings();
      return null;
    }
    await act(async () =>
      root.render(
        React.createElement(
          SettingsProvider,
          null,
          React.createElement(App),
          React.createElement(Probe),
        ),
      ),
    );
    const state = () => JSON.parse(localStorage.getItem(workspaceKey));
    const action = (payload) => act(async () => emit("app-menu-action", payload));
    const save = (patch) => act(async () => context.save({ ...context.settings, ...patch }, true));
    const flatten = (menu) =>
      menu.items.flatMap((item) => [item, ...(item.items ? flatten(item) : [])]);
    const item = (id) => flatten(snapshots.at(-1)).find((entry) => entry.id === id);
    assert.ok(
      item("app-menu:session:local-session"),
      document.querySelector('[role="alert"]')?.textContent,
    );
    assert.equal(item("app-menu:session:local-session").checked, true);
    const key = (code, patch = {}) =>
      act(async () => {
        const event = new dom.window.KeyboardEvent("keydown", {
          code,
          metaKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
          ...patch,
        });
        window.dispatchEvent(event);
      });
    assert.equal(item("app-menu:command:nextWorkspace").accelerator, "Cmd+Alt+BracketRight");
    await key("BracketRight");
    assert.equal(state().selectedWorkspace, "other");
    await key("BracketLeft");
    assert.equal(state().selectedWorkspace, "local");
    assert.equal(state().selectedSession, "local-session");
    await key("BracketRight", { repeat: true });
    await key("BracketRight", { isComposing: true });
    assert.equal(state().selectedWorkspace, "local");
    await save({ shortcuts: { nextWorkspace: "" } });
    await key("BracketRight");
    assert.equal(state().selectedWorkspace, "local");
    await save({ shortcuts: { nextWorkspace: "Mod+Shift+Digit9" } });
    await key("Digit9", { altKey: false, shiftKey: true });
    assert.equal(state().selectedWorkspace, "other");
    await action("command:previousWorkspace");
    assert.equal(state().selectedWorkspace, "local");
    await save({ shortcuts: {} });
    const originalSetItem = dom.window.Storage.prototype.setItem;
    try {
      dom.window.Storage.prototype.setItem = function (key, value) {
        if (key === workspaceKey) throw Error("Workspace storage denied");
        return originalSetItem.call(this, key, value);
      };
      await key("BracketRight");
      assert.equal(state().selectedWorkspace, "local");
      assert.match(
        document.querySelector('[role="alert"]').textContent,
        /Workspace storage denied/,
      );
    } finally {
      dom.window.Storage.prototype.setItem = originalSetItem;
    }
    await action("command:toggleSidebar");
    assert.ok(document.querySelector('[aria-label="Show sidebar"]'));
    assert.equal(item("app-menu:command:toggleSidebar").checked, false);
    await action("workspace:other");
    assert.equal(state().selectedWorkspace, "other");
    await action("session:local-session");
    assert.equal(state().selectedWorkspace, "local");
    assert.equal(state().selectedSession, "local-session");
    const beforeReselect = installed.length;
    await action("session:local-session");
    assert.ok(installed.length > beforeReselect);
    assert.equal(item("app-menu:session:local-session").checked, true);
    await action("command:next");
    assert.equal(state().selectedSession, "other-session");
    await action("command:close");
    assert.equal(globalThis.nativeMenuTerminal.closeRequest.id, "other-session");
    assert.equal(state().groups[0].terminals[0].id, "local-session");
    await action("new-workspace");
    assert.ok(document.querySelector("dialog[open]"));
    assert.equal(item("app-menu:command:nextWorkspace").enabled, false);
    await key("BracketRight");
    await action("command:previousWorkspace");
    assert.equal(state().selectedWorkspace, "other");
    assert.equal(item("app-menu:workspace:local").enabled, false);
    await action("workspace:local");
    assert.equal(state().selectedWorkspace, "other");
    await save({ language: "zh-Hans" });
    assert.equal(snapshots.at(-1).items.at(-1).text, "帮助");
    const cancel = [...document.querySelectorAll("dialog[open] button")].find(
      (button) => button.textContent === "取消",
    );
    await act(async () => cancel.click());
    await save({ shortcuts: { toggleSidebar: "Mod+Alt+KeyL" } });
    assert.equal(item("app-menu:command:toggleSidebar").accelerator, "Cmd+Alt+KeyL");
    await save({ shortcuts: { toggleSidebar: "" } });
    assert.equal(item("app-menu:command:toggleSidebar").accelerator, undefined);
    await action("guide");
    assert.match(external.at(-1), /features\.zh-CN\.md$/);
    delayNext = true;
    await save({ language: "en" });
    const delayed = snapshots.at(-1).rid;
    await save({ language: "zh-Hans" });
    await act(async () => release());
    assert.ok(closed.includes(delayed));
    assert.ok(!installed.includes(delayed));
    assert.equal(snapshots.at(-1).items.at(-1).text, "帮助");
    failNext = true;
    await save({ language: "en" });
    assert.match(document.querySelector('[role="alert"]').textContent, /Menu denied/);
    assert.equal(state().groups.flatMap((group) => group.terminals).length, 2);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
