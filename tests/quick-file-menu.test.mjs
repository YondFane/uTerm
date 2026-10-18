import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("quick-open menus copy the selected file, copy normalized names/paths and reveal the exact target", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const text = [];
  let clipboardFailure = false;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value) => {
        if (clipboardFailure) throw Error("Clipboard denied");
        text.push(value);
      },
    },
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { FilePanel } = await server.ssrLoadModule("/src/components/FilePanel.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const directory = String.raw`\\?\D:\QA root`;
  const path = "nested/中文 file.txt";
  const calls = [];
  const opened = [];
  let mode = "quick";
  let revealFailure = false;
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "files_search")
      return {
        matches: [
          { path, line: 0, text: "" },
          { path: "other.txt", line: 0, text: "" },
        ],
        partial: false,
        skipped: 0,
      };
    if (command === "files_list") return { entries: [], partial: false, skipped: 0 };
    if (command === "file_copy") return null;
    if (command === "file_reveal") {
      if (revealFailure) throw Error("File manager unavailable");
      return null;
    }
    throw Error(command);
  });
  const render = () =>
    root.render(
      React.createElement(FilePanel, {
        directory,
        mode,
        request: 0,
        resizeHandle: null,
        headerActions: null,
        open: (value) => opened.push(value),
        setMode: (value) => {
          mode = value;
          render();
        },
        beforeMutation: (action) => action(),
      }),
    );
  const menu = async (keyboard = false) => {
    const row = document.querySelector(".file-hit");
    await act(async () =>
      row.dispatchEvent(
        keyboard
          ? new window.KeyboardEvent("keydown", {
              key: "F10",
              shiftKey: true,
              bubbles: true,
              cancelable: true,
            })
          : new window.MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: 500,
              clientY: 400,
            }),
      ),
    );
    return [...document.querySelectorAll('[role="menuitem"]')];
  };
  const click = async (label) => {
    const button = [...document.querySelectorAll('[role="menuitem"]')].find(
      (e) => e.textContent === label,
    );
    assert.ok(button, label);
    await act(async () => button.click());
  };
  try {
    setUiLanguage("en");
    await act(async () => render());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    let items = await menu();
    assert.deepEqual(
      items.map((e) => e.textContent),
      ["Copy", "Copy file name", "Copy file path", "Open in File Manager"],
    );
    assert.deepEqual(opened, []);
    await click("Copy file name");
    assert.equal(text.pop(), "中文 file.txt");
    await menu();
    await click("Copy file path");
    assert.equal(text.pop(), String.raw`D:\QA root\nested\中文 file.txt`);
    await menu();
    await click("Open in File Manager");
    assert.deepEqual(calls.filter((e) => e.command === "file_reveal").at(-1).args, {
      directory,
      path,
    });
    await menu();
    await click("Copy");
    await act(async () => {
      mode = "tree";
      render();
    });
    await act(async () =>
      document
        .querySelector(".file-results")
        .dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    await click("Paste");
    assert.deepEqual(calls.filter((e) => e.command === "file_copy").at(-1).args, {
      directory,
      sourceDirectory: directory,
      path,
      destination: "",
    });
    await act(async () => {
      mode = "quick";
      render();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    items = await menu(true);
    assert.equal(document.activeElement, items[0]);
    await act(async () =>
      document.activeElement.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(document.activeElement, document.querySelector(".file-hit"));
    assert.equal(document.querySelector('[role="menu"]'), null);
    await menu();
    revealFailure = true;
    await click("Open in File Manager");
    assert.match(document.querySelector('[role="alert"]').textContent, /File manager unavailable/);
    await menu();
    clipboardFailure = true;
    await click("Copy file path");
    assert.match(document.querySelector('[role="alert"]').textContent, /Clipboard denied/);
    await act(async () => setUiLanguage("zh-Hans"));
    items = await menu();
    assert.deepEqual(
      items.map((e) => e.textContent),
      ["复制", "复制文件名", "复制文件路径", "在文件管理器中打开"],
    );
    await act(async () => {
      mode = "tree";
      render();
    });
    assert.equal(document.querySelector('[role="menu"]'), null);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
