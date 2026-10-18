import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("file-tab menus preserve the active draft and copy or reveal the clicked file", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.innerWidth = 640;
  window.innerHeight = 420;
  HTMLElement.prototype.scrollIntoView = () => {};
  HTMLElement.prototype.getBoundingClientRect = () => ({ width: 220, height: 146 });
  const written = [];
  let clipboardFailure = false;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      async writeText(text) {
        if (clipboardFailure) throw new Error("Clipboard denied");
        written.push(text);
      },
    },
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    const { WorkspaceTabs } = await server.ssrLoadModule("/src/components/WorkspaceTabs.tsx");
    const { FilePanel } = await server.ssrLoadModule("/src/components/FilePanel.tsx");
    const { remoteDirectory } = await server.ssrLoadModule("/src/lib/file-target.ts");
    const { setFileClipboard, useFileClipboard } = await server.ssrLoadModule(
      "/src/lib/file-clipboard.ts",
    );
    const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
    setUiLanguage("en");
    const directory = String.raw`\\?\D:\QA root`;
    const makeFile = (id, path, root = directory) => ({
      id,
      path,
      directory: root,
      kind: "text",
      text: "unsaved draft",
      saved: "saved text",
      version: "a".repeat(64),
      line_ending: "\n",
      bom: false,
      readonly: false,
      notice: null,
      jump: 0,
    });
    const first = makeFile(1, "AGENTS.md");
    const second = makeFile(2, "folder/中文 file.txt");
    let documents = [first, second];
    let disabled = false;
    let clipboard;
    const selections = [];
    const closes = [];
    const calls = [];
    let revealFailure = false;
    mockIPC((command, args) => {
      calls.push({ command, args });
      if (command === "files_list") return { entries: [], partial: false, skipped: 0 };
      if (command === "file_reveal" && revealFailure) throw new Error("Reveal failed");
      return null;
    });
    function Harness() {
      clipboard = useFileClipboard();
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(WorkspaceTabs, {
          sessions: [],
          documents,
          activeFile: 1,
          activeSession: null,
          detectedAgents: {},
          disabled,
          selectSession() {},
          selectFile: (file) => selections.push(file.id),
          closeFile: (id) => closes.push(id),
        }),
        React.createElement(FilePanel, {
          directory: "D:/Destination",
          mode: "tree",
          request: 0,
          resizeHandle: null,
          headerActions: null,
          setMode() {},
          open() {},
          beforeMutation: (action) => action(),
        }),
      );
    }
    const render = () => act(async () => root.render(React.createElement(Harness)));
    const tab = () => document.getElementById(`workspace-file-${documents.at(-1).id}`);
    const openMenu = async (element = tab()) => {
      await act(async () =>
        element.dispatchEvent(
          new window.MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 639,
            clientY: 419,
          }),
        ),
      );
      return document.querySelector(".workspace-file-menu");
    };
    const click = async (label) => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find(
        (b) => b.textContent === label,
      );
      assert.ok(item, label);
      await act(async () => item.click());
    };
    const key = async (value) =>
      act(async () =>
        document.activeElement.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
        ),
      );
    await render();
    assert.equal(tab().title, "D:\\QA root\\folder\\中文 file.txt");
    const menu = await openMenu();
    assert.equal(menu.parentElement, document.body);
    assert.equal(menu.style.left, "412px");
    assert.equal(menu.style.top, "266px");
    assert.deepEqual(
      [...menu.querySelectorAll("button")].map((b) => b.textContent),
      ["Copy", "Copy file name", "Copy file path", "Open in File Manager"],
    );
    assert.equal(document.activeElement.textContent, "Copy");
    await key("End");
    assert.equal(document.activeElement.textContent, "Open in File Manager");
    await key("ArrowDown");
    assert.equal(document.activeElement.textContent, "Copy");
    await key("Escape");
    assert.equal(document.activeElement, tab());
    assert.equal(document.querySelector(".workspace-file-menu"), null);
    await act(async () =>
      tab().dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await click("Copy");
    assert.deepEqual(clipboard, { directory, path: second.path });
    await act(async () =>
      document.querySelector(".file-results").dispatchEvent(
        new window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await click("Paste");
    assert.deepEqual(calls.find((c) => c.command === "file_copy").args, {
      directory: "D:/Destination",
      sourceDirectory: directory,
      path: second.path,
      destination: "",
    });
    await openMenu();
    await click("Copy file name");
    assert.equal(written.at(-1), "中文 file.txt");
    await openMenu();
    await click("Copy file path");
    assert.equal(written.at(-1), "D:\\QA root\\folder\\中文 file.txt");
    await openMenu();
    await click("Open in File Manager");
    assert.deepEqual(calls.find((c) => c.command === "file_reveal").args, {
      directory,
      path: second.path,
    });
    assert.deepEqual(selections, []);
    assert.deepEqual(closes, []);
    assert.equal(document.querySelector('[aria-selected="true"]').id, "workspace-file-1");
    assert.equal(first.text, "unsaved draft");
    clipboardFailure = true;
    await openMenu();
    await click("Copy file path");
    assert.match(document.querySelector('[role="alert"]').textContent, /Clipboard denied/);
    clipboardFailure = false;
    revealFailure = true;
    await openMenu();
    await click("Open in File Manager");
    assert.match(document.querySelector('[role="alert"]').textContent, /Reveal failed/);
    await act(async () => setUiLanguage("zh-Hans"));
    await openMenu();
    assert.deepEqual(
      [...document.querySelectorAll(".workspace-file-menu button")].map((b) => b.textContent),
      ["复制", "复制文件名", "复制文件路径", "在文件管理器中打开"],
    );
    await act(async () => window.dispatchEvent(new window.Event("blur")));
    assert.equal(document.querySelector(".workspace-file-menu"), null);
    await openMenu();
    disabled = true;
    await render();
    assert.equal(document.querySelector(".workspace-file-menu"), null);
    await openMenu();
    assert.equal(document.querySelector(".workspace-file-menu"), null);
    disabled = false;
    await render();
    await openMenu();
    documents = [first];
    await render();
    assert.equal(document.querySelector(".workspace-file-menu"), null);
    const remote = remoteDirectory({
      identity: "a".repeat(64),
      path: "/home/qa",
      connection: {
        connection_id: "ssh",
        workspace_id: "main",
        name: "QA",
        host: "qa-host",
        os: "posix",
        root: "/home/qa",
      },
    });
    documents = [first, makeFile(3, "remote.txt", remote)];
    await render();
    await openMenu();
    assert.deepEqual(
      [...document.querySelectorAll(".workspace-file-menu button")].map((b) => b.disabled),
      [true, false, false, true],
    );
    await click("复制文件路径");
    assert.equal(written.at(-1), "ssh://qa-host/home/qa/remote.txt");
    await act(async () => setFileClipboard(null));
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
