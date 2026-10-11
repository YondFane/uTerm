import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";

test("content font changes retain editor state and all Git diff modes, including portals", async () => {
  const dom = new JSDOM('<div id="root"></div><div id="diff-target"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Window",
    "Node",
    "MutationObserver",
    "localStorage",
  ])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const load = (path) => server.ssrLoadModule(`/src/${path}`);
  const { SettingsProvider, useSettings } = await load("lib/SettingsContext.tsx");
  const { defaults, settingsKey } = await load("lib/settings.ts");
  const { FileEditor } = await load("components/FileEditor.tsx");
  const { GitPanel } = await load("components/GitPanel.tsx");
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  const target = document.getElementById("diff-target");
  const root = createRoot(host);
  let context;
  let changes = 0;
  let saves = 0;
  let expanded = false;
  const commands = [];
  const change = { path: "font.txt", index: "M", working: "M" };
  mockIPC((command, args) => {
    commands.push({ command, args });
    if (command === "git_snapshot")
      return { changes: [change], references: ["release", "other"], branch: "release" };
    if (command === "git_diff")
      return {
        text: "diff --git a/font.txt b/font.txt\n--- a/font.txt\n+++ b/font.txt\n@@ -1 +1 @@\n-before\n+after",
        truncated: false,
      };
    if (command === "git_files") return [change];
    if (command === "git_history")
      return [
        {
          id: "a".repeat(40),
          parents: [],
          subject: "Font fixture",
          author: "Fixture",
          timestamp: "2026-10-11T00:00:00Z",
        },
      ];
    if (command === "window_appearance") return null;
    throw new Error(command);
  });
  let file = {
    id: 1,
    directory: "C:/fixture",
    path: "font.txt",
    kind: "text",
    text: "before",
    saved: "before",
    version: "1",
    line_ending: "\n",
    bom: false,
    readonly: false,
    jump: 0,
  };
  const expand = (value) => {
    if (expanded !== value) {
      expanded = value;
      render();
    }
  };
  function Harness() {
    context = useSettings();
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(FileEditor, {
        editor: {
          document: file,
          saving: false,
          transitioning: false,
          change: () => changes++,
          save: () => saves++,
          close() {},
          reload() {},
          error: "",
        },
      }),
      React.createElement(GitPanel, {
        directory: "C:/fixture",
        expanded,
        diffTarget: target,
        onExpandedChange: expand,
        resizeHandle: null,
        headerActions: null,
      }),
    );
  }
  function render() {
    root.render(React.createElement(SettingsProvider, null, React.createElement(Harness)));
  }
  async function click(text) {
    const button = [...document.querySelectorAll("button")].find(
      (element) =>
        element.textContent.replace(/\s/g, "") === text.replace(/\s/g, "") ||
        element.getAttribute("aria-label") === text,
    );
    assert.ok(button, text);
    await act(async () => button.click());
  }
  async function resize(fileFontSize, gitDiffFontSize) {
    await act(async () =>
      context.save({ ...context.settings, fileFontSize, gitDiffFontSize }, false),
    );
    assert.equal(
      document.documentElement.style.getPropertyValue("--file-font-size"),
      `${fileFontSize}px`,
    );
    assert.equal(
      document.documentElement.style.getPropertyValue("--git-diff-font-size"),
      `${gitDiffFontSize}px`,
    );
  }
  try {
    localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
    await act(async () => render());
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor"));
    assert.ok(view);
    await act(async () =>
      view.dispatch({ changes: { from: 6, insert: " draft" }, selection: { anchor: 8 } }),
    );
    assert.equal(changes, 1);
    await resize(20, 32);
    assert.equal(EditorView.findFromDOM(host.querySelector(".cm-editor")), view);
    assert.equal(view.state.doc.toString(), "before draft");
    assert.equal(view.state.selection.main.head, 8);
    assert.equal(changes, 1);
    assert.equal(saves, 0);
    await act(async () => assert.ok(undo(view)));
    assert.equal(view.state.doc.toString(), "before");
    await click("M font.txt");
    assert.ok(host.querySelector(".git-diff pre"));
    const diffReads = commands.filter((entry) => entry.command === "git_diff").length;
    await resize(32, 20);
    assert.equal(commands.filter((entry) => entry.command === "git_diff").length, diffReads);
    await click("Switch to side-by-side diff");
    assert.ok(host.querySelector(".git-side-diff"));
    await click("Show diff in the main workspace and keep the inspector");
    assert.ok(target.querySelector(".git-side-diff"));
    await resize(14, 32);
    assert.ok(target.querySelector(".git-side-diff"));
    await click("Changes");
    const working = [...host.querySelectorAll(".git-file")].at(-1);
    await act(async () => working.click());
    assert.equal(
      commands.filter((entry) => entry.command === "git_diff").at(-1).args.mode,
      "working",
    );
    await click("Compare");
    const branch = host.querySelector(".git-list-area select");
    await act(async () => {
      branch.value = "other";
      branch.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await click("M font.txt");
    assert.equal(
      commands.filter((entry) => entry.command === "git_diff").at(-1).args.mode,
      "compare",
    );
    await click("History");
    await act(async () => host.querySelector(".git-commit").click());
    await click("M font.txt");
    assert.equal(
      commands.filter((entry) => entry.command === "git_diff").at(-1).args.mode,
      "commit",
    );
    file = {
      ...file,
      id: 2,
      path: "font.md",
      readonly: true,
      text: "# Heading\n\nPreview `code`",
      saved: "# Heading\n\nPreview `code`",
    };
    await act(async () => render());
    assert.ok(host.querySelector(".markdown-preview h1"));
    await resize(20, 14);
    await click("Edit");
    assert.equal(host.querySelector(".cm-content").getAttribute("contenteditable"), "false");
    await click("Preview");
    assert.match(host.querySelector(".markdown-preview").textContent, /Heading/);
    assert.equal(saves, 0);
    assert.equal(JSON.parse(localStorage.getItem(settingsKey)).fileFontSize, 20);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
