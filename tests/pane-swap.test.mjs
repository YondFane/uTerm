import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("App swaps mounted panes, keeps drafts and tree state, persists position and reports save failures", async (t) => {
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
  dom.window.HTMLElement.prototype.setPointerCapture = function () {};
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
  globalThis.isTauri = true;
  globalThis.paneMounts = 0;
  globalThis.paneUnmounts = 0;
  const server = await createServer({
    configFile: false,
    plugins: [
      {
        name: "pane-test-renderers",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/TerminalWorkspace") || id.endsWith("/DeferredFileEditor"))
            return "\0pane:" + id.split("/").at(-1);
        },
        load(id) {
          if (id === "\0pane:TerminalWorkspace")
            return `
          import React, { useEffect } from 'react';
          export function TerminalWorkspace({ closeRequest }) {
            globalThis.paneCloseRequest = closeRequest;
            useEffect(() => { globalThis.paneMounts++; return () => { globalThis.paneUnmounts++; }; }, []);
            return React.createElement('div', { className: 'terminal-test' }, 'retained terminal output');
          }`;
          if (id === "\0pane:DeferredFileEditor")
            return `
          import React from 'react';
          export function DeferredFileEditor({ editor }) {
            globalThis.paneEditor = editor;
            return editor.document ? React.createElement('textarea', { className: 'editor-test', value: editor.document.text, readOnly: true }) : null;
          }`;
        },
      },
    ],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const calls = [];
  mockIPC((command, args) => {
    calls.push(command);
    if (command === "runtime_info")
      return {
        platform: "macos",
        home: "/test",
        agents: [],
        agent_definitions: [],
        version: "test",
        debug: true,
        chat_directory: "/test",
      };
    if (command === "local_session_list") return { sessions: [], closed: [] };
    if (command === "project_worktrees") return [];
    if (command === "update_status") return { enabled: false, version: "", downloaded: false };
    if (command === "git_branches") return { current: "main", local: ["main"] };
    if (command === "agent_usage")
      return {
        windows: [
          {
            label: "主要额度",
            percent: 74,
            resetsAt: "2026-09-29T00:00:00Z",
          },
        ],
      };
    if (command === "files_list")
      return {
        entries: args.path
          ? [{ path: "src/a.txt", name: "a.txt", directory: false, symlink: false }]
          : [{ path: "src", name: "src", directory: true, symlink: false }],
        partial: false,
        skipped: 0,
      };
    if (command === "git_snapshot")
      return {
        root: "/test",
        branch: "main",
        references: ["main"],
        changes: [{ path: "src/a.txt", original: null, index: " ", working: "M" }],
        truncated: false,
      };
    if (command === "git_diff")
      return {
        text: "diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-original\n+changed",
        truncated: false,
      };
    if (command === "file_read")
      return {
        kind: "text",
        text: "original",
        version: "a".repeat(64),
        line_ending: "\n",
        bom: false,
        readonly: false,
        notice: null,
      };
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
    const { setUiLanguage } = await load("lib/i18n.ts");
    localStorage.setItem(
      settingsKey,
      JSON.stringify({ ...defaults, language: "en", shortcuts: { swapPanes: "Mod+Alt+KeyS" } }),
    );
    const workspace = emptyWorkspace();
    workspace.projects = [
      {
        id: "project",
        name: "Test",
        directory: "/test",
        workspaceId: workspace.selectedWorkspace,
        sessions: [
          {
            id: "agent-session",
            name: "Codex",
            shell: "default",
            agent: "codex",
            directory: "/test",
          },
        ],
        worktrees: [],
      },
    ];
    workspace.selectedProject = "project";
    workspace.selectedSession = "agent-session";
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
    const shell = () => document.querySelector(".app-shell");
    const swap = () => document.querySelector(".pane-swap-button");
    const inspectorToggle = () => document.querySelector(".inspector-toggle");
    const click = (node) => act(async () => node.click());
    const shortcut = () =>
      act(async () =>
        window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "s",
            code: "KeyS",
            metaKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    await render();
    assert.ok(swap());
    assert.equal(swap().title, "Swap left and right panes");
    assert.equal(
      inspectorToggle().closest(".toolbar-actions"),
      document.querySelector(".toolbar-actions"),
    );
    assert.equal(globalThis.paneMounts, 1);
    const usageButton = document.querySelector(".chat-usage");
    assert.ok(usageButton);
    assert.equal(usageButton.textContent.trim(), "26% remaining");
    await click(usageButton);
    const usageDetails = document.querySelector(".chat-usage-popover");
    assert.ok(usageDetails);
    assert.match(usageDetails.textContent, /Codex usage details/);
    assert.match(usageDetails.textContent, /Primary quota/);
    assert.match(usageDetails.textContent, /26% remaining/);
    await act(async () =>
      window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })),
    );
    assert.equal(document.querySelector(".chat-usage-popover"), null);
    await click(usageButton);
    await act(async () =>
      document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })),
    );
    assert.equal(document.querySelector(".chat-usage-popover"), null);
    const terminal = document.querySelector(".terminal-test");
    await click(document.querySelector('.file-row[title="src"]'));
    await click(document.querySelector('.file-row[title="src/a.txt"]'));
    await act(async () => globalThis.paneEditor.change("unsaved draft"));
    const editor = document.querySelector(".editor-test");
    const filePanel = document.querySelector(".file-panel");
    document.querySelector(".file-results").scrollTop = 72;
    const callsBeforeSwap = calls.length;
    for (let i = 0; i < 3; i++) {
      await click(swap());
      assert.equal(shell().dataset.inspectorPosition, i % 2 === 0 ? "left" : "right");
      if (i % 2 === 0)
        assert.equal(
          inspectorToggle().closest(".workspace-heading"),
          document.querySelector(".workspace-heading"),
        );
      else
        assert.equal(
          inspectorToggle().closest(".toolbar-actions"),
          document.querySelector(".toolbar-actions"),
        );
      assert.equal(inspectorToggle().closest(".inspector-switcher"), null);
      assert.strictEqual(document.querySelector(".terminal-test"), terminal);
      assert.strictEqual(document.querySelector(".editor-test"), editor);
      assert.strictEqual(document.querySelector(".file-panel"), filePanel);
      assert.equal(editor.value, "unsaved draft");
      assert.equal(
        document.querySelector('.file-row[title="src"]').getAttribute("aria-expanded"),
        "true",
      );
      assert.equal(document.querySelector(".file-results").scrollTop, 72);
    }
    assert.equal(globalThis.paneMounts, 1);
    assert.equal(globalThis.paneUnmounts, 0);
    assert.deepEqual(
      calls
        .slice(callsBeforeSwap)
        .filter((name) => ["file_save", "file_read", "files_list", "editor_guard"].includes(name)),
      [],
    );
    assert.equal(JSON.parse(localStorage.getItem(settingsKey)).inspectorPosition, "left");
    await shortcut();
    assert.equal(shell().dataset.inspectorPosition, "right");
    const saved = localStorage.getItem(settingsKey);
    dom.window.Storage.prototype.setItem = function (key, value) {
      if (key === settingsKey) throw new Error("storage unavailable");
      return originalSetItem.call(this, key, value);
    };
    await click(swap());
    assert.equal(shell().dataset.inspectorPosition, "right");
    assert.equal(localStorage.getItem(settingsKey), saved);
    assert.match(document.body.textContent, /Could not save pane position.*storage unavailable/);
    dom.window.Storage.prototype.setItem = originalSetItem;
    await click(swap());
    await click(document.querySelector('button[aria-label="Hide inspector"]'));
    assert.equal(
      inspectorToggle().closest(".workspace-heading"),
      document.querySelector(".workspace-heading"),
    );
    assert.equal(swap(), null);
    await shortcut();
    assert.equal(shell().dataset.inspectorPosition, "left");
    await click(document.querySelector('button[aria-label="Show inspector"]'));
    assert.equal(shell().dataset.inspectorPosition, "left");
    assert.ok(swap());
    await click(document.querySelector('button[aria-label="Git"]'));
    await click(document.querySelector(".git-files button"));
    await click(
      document.querySelector(
        'button[aria-label="Show diff in the main workspace and keep the inspector"]',
      ),
    );
    assert.equal(shell().dataset.expandedInspector, "true");
    assert.ok(document.querySelector(".git-main-diff .git-diff"));
    const diffTab = () => document.querySelector("#workspace-git-diff");
    assert.equal(diffTab().getAttribute("aria-selected"), "true");
    await click(document.querySelector('[role="tab"][id^="workspace-session-"]'));
    assert.equal(document.querySelector(".git-main-diff").hidden, true);
    assert.equal(diffTab().getAttribute("aria-selected"), "false");
    await click(diffTab());
    assert.equal(document.querySelector(".git-main-diff").hidden, false);
    assert.equal(diffTab().getAttribute("aria-selected"), "true");
    assert.ok(document.querySelector(".git-panel .git-list-area"));
    assert.equal(document.querySelector(".git-panel").hasAttribute("data-diff-focused"), false);
    assert.ok(document.querySelector("main > .toolbar"));
    assert.equal(swap(), null);
    await shortcut();
    assert.equal(shell().dataset.inspectorPosition, "left");
    await click(
      document.querySelector(
        'button[aria-label="Expand diff in the inspector and keep the main workspace"]',
      ),
    );
    assert.ok(swap());
    assert.equal(shell().dataset.expandedInspector, undefined);
    assert.equal(shell().dataset.inspectorPosition, "left");
    await act(async () => prefs.save({ ...prefs.settings, language: "zh-Hans" }, true));
    assert.equal(swap().title, "交换左右窗格");
    await act(async () => root.unmount());
    await render();
    assert.equal(shell().dataset.inspectorPosition, "left");
    await act(async () => prefs.reset());
    assert.equal(shell().dataset.inspectorPosition, "right");
    await act(async () => setUiLanguage("en"));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hint = (selector) =>
      document.querySelector(selector)?.hasAttribute("data-collapse-hint") ?? false;
    const pointer = (node, type, clientX) =>
      act(async () =>
        node.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX })),
      );
    const drag = async (selector, end, finish = "pointerup", back) => {
      const node = document.querySelector(selector);
      await pointer(node, "pointerdown", 600);
      await pointer(node, "pointermove", end);
      assert.equal(
        hint(selector === ".sidebar-resizer" ? ".sidebar-reopen" : ".inspector-toggle"),
        false,
      );
      if (back !== undefined) await pointer(node, "pointermove", back);
      await pointer(node, finish, back ?? end);
    };
    await click(document.querySelector(".sidebar-toggle"));
    assert.equal(hint(".sidebar-reopen"), false);
    await click(document.querySelector(".sidebar-reopen"));
    await click(document.querySelector(".inspector-toggle"));
    assert.equal(hint(".inspector-toggle"), false);
    await click(document.querySelector(".inspector-toggle"));
    await drag(".sidebar-resizer", -1000, "pointercancel");
    assert.equal(document.querySelector(".sidebar-reopen"), null);
    await drag(".sidebar-resizer", -1000, "pointerup", 800);
    assert.equal(document.querySelector(".sidebar-reopen"), null);
    await drag(".inspector-resizer", 2000, "pointercancel");
    assert.equal(hint(".inspector-toggle"), false);
    await drag(".inspector-resizer", 2000, "pointerup", 400);
    assert.equal(hint(".inspector-toggle"), false);
    await drag(".sidebar-resizer", -1000);
    assert.equal(hint(".sidebar-reopen"), true);
    await act(async () => t.mock.timers.tick(2999));
    assert.equal(hint(".sidebar-reopen"), true);
    await act(async () => t.mock.timers.tick(1));
    assert.equal(hint(".sidebar-reopen"), false);
    await click(document.querySelector(".sidebar-reopen"));
    for (const side of ["right", "left"]) {
      if (side === "left") await click(swap());
      await drag(".inspector-resizer", side === "right" ? 2000 : -1000);
      assert.equal(hint(".inspector-toggle"), true);
      await act(async () => t.mock.timers.tick(2999));
      assert.equal(hint(".inspector-toggle"), true);
      await act(async () => t.mock.timers.tick(1));
      assert.equal(hint(".inspector-toggle"), false);
      await click(document.querySelector(".inspector-toggle"));
    }
    await drag(".sidebar-resizer", -1000);
    await act(async () => t.mock.timers.tick(1000));
    await click(document.querySelector(".sidebar-reopen"));
    await click(document.querySelector(".sidebar-toggle"));
    assert.equal(hint(".sidebar-reopen"), false);
    await click(document.querySelector(".sidebar-reopen"));
    await drag(".sidebar-resizer", -1000);
    await act(async () => t.mock.timers.tick(2000));
    assert.equal(hint(".sidebar-reopen"), true);
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(hint(".sidebar-reopen"), false);
    await click(document.querySelector(".sidebar-reopen"));
    await drag(".sidebar-resizer", -1000);
    await act(async () => t.mock.timers.tick(1000));
    await drag(".inspector-resizer", -1000);
    assert.equal(hint(".sidebar-reopen"), true);
    assert.equal(hint(".inspector-toggle"), true);
    await act(async () => t.mock.timers.tick(2000));
    assert.equal(hint(".sidebar-reopen"), false);
    assert.equal(hint(".inspector-toggle"), true);
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(hint(".inspector-toggle"), false);
    await click(document.querySelector(".inspector-toggle"));
    await drag(".inspector-resizer", -1000);
    await click(document.querySelector(".inspector-toggle"));
    await click(document.querySelector(".inspector-toggle"));
    assert.equal(hint(".inspector-toggle"), false);
    t.mock.timers.reset();
    await act(async () => globalThis.paneEditor.open("/test", "shortcut.txt"));
    await act(async () => globalThis.paneEditor.open("/test", "another.txt"));
    await act(async () => globalThis.paneEditor.change("retained tab draft"));
    const fileTab = (path) => document.querySelector(`[role="tab"][title="/test/${path}"]`);
    await click(fileTab("shortcut.txt"));
    assert.equal(globalThis.paneEditor.document?.path, "shortcut.txt");
    assert.equal(document.querySelector(".editor-test").value, "original");
    await click(fileTab("another.txt"));
    assert.equal(globalThis.paneEditor.document?.path, "another.txt");
    assert.equal(document.querySelector(".editor-test").value, "retained tab draft");
    await click(document.querySelector('[role="tab"][id^="workspace-session-"]'));
    assert.equal(globalThis.paneEditor.document, null);
    await click(fileTab("shortcut.txt"));
    assert.equal(globalThis.paneEditor.document?.path, "shortcut.txt");
    await act(async () => globalThis.paneEditor.change("shortcut draft"));
    const sessionsBeforeClose = JSON.parse(localStorage.getItem(workspaceKey)).projects[0].sessions;
    await act(async () =>
      window.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "w",
          code: "KeyW",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.equal(globalThis.paneEditor.document, null);
    assert.ok(!globalThis.paneEditor.documents.some((file) => file.path === "shortcut.txt"));
    assert.equal(globalThis.paneCloseRequest, null);
    assert.deepEqual(
      JSON.parse(localStorage.getItem(workspaceKey)).projects[0].sessions,
      sessionsBeforeClose,
    );
    assert.ok(calls.includes("file_save"));
  } finally {
    t.mock.timers.reset();
    dom.window.Storage.prototype.setItem = originalSetItem;
    if (root) await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.paneEditor;
    delete globalThis.paneCloseRequest;
    delete globalThis.isTauri;
  }
});
