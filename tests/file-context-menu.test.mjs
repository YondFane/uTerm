import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("file-manager actions stay within the window and retain their target and visible errors", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.innerWidth = 640;
  window.innerHeight = 600;
  let naturalHeight = 378;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      width: 220,
      height: Math.min(naturalHeight, window.innerHeight - 16),
    };
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { FilePanel } = await server.ssrLoadModule("/src/components/FilePanel.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  let fail = false;
  mockIPC((command, args) => {
    if (command === "files_list")
      return {
        entries: [
          { path: "folder", name: "folder", directory: true, symlink: false },
          { path: "中文 file.txt", name: "中文 file.txt", directory: false, symlink: false },
        ],
        partial: false,
        skipped: 0,
      };
    assert.equal(command, "file_reveal");
    calls.push(args);
    if (fail) throw new Error("File manager unavailable");
    return null;
  });
  const openMenu = async (target, x = 639, y = 599) => {
    await act(async () =>
      target.dispatchEvent(
        new window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        }),
      ),
    );
    return document.querySelector('[role="menu"]');
  };
  try {
    await act(async () => {
      setUiLanguage("zh-Hans");
      root.render(
        React.createElement(FilePanel, {
          directory: "C:/QA root",
          mode: "tree",
          request: 0,
          resizeHandle: null,
          headerActions: null,
          setMode() {},
          open() {},
          beforeMutation() {},
        }),
      );
    });
    for (const [language, label] of [
      ["zh-Hans", "在文件管理器中打开"],
      ["en", "Open in File Manager"],
    ]) {
      await act(async () => setUiLanguage(language));
      for (const path of ["中文 file.txt", "folder", ""]) {
        const target = path
          ? document.querySelector(`.file-row[title="${path}"]`)
          : document.querySelector(".file-results");
        const menu = await openMenu(target);
        assert.equal(menu.style.maxHeight, "calc(100vh - 16px)");
        assert.equal(menu.style.maxWidth, "calc(100vw - 16px)");
        assert.equal(menu.style.left, "412px");
        assert.equal(menu.style.top, "214px");
        const reveal = [...menu.querySelectorAll("button")].find((b) => b.textContent === label);
        assert.ok(reveal);
        assert.equal(reveal.disabled, false);
        await act(async () => reveal.click());
        assert.deepEqual(calls.pop(), { directory: "C:/QA root", path });
        assert.equal(document.querySelector('[role="menu"]'), null);
      }
    }
    const row = document.querySelector('.file-row[title="中文 file.txt"]');
    let menu = await openMenu(row, 0, 0);
    assert.equal(menu.style.left, "8px");
    assert.equal(menu.style.top, "8px");
    await openMenu(row);
    naturalHeight = 420;
    await act(async () => setUiLanguage("zh-Hans"));
    menu = document.querySelector('[role="menu"]');
    assert.equal(menu.style.top, "172px");
    window.innerHeight = 260;
    menu = await openMenu(row, 639, 259);
    assert.equal(menu.style.top, "8px");
    const items = [...menu.querySelectorAll("button:not(:disabled)")];
    assert.equal(document.activeElement, items[0]);
    for (let index = 0; index < 2; index++)
      await act(async () =>
        document.activeElement.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
        ),
      );
    assert.equal(document.activeElement.textContent, "在文件管理器中打开");
    fail = true;
    await act(async () => document.activeElement.click());
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.match(document.querySelector('[role="alert"]').textContent, /File manager unavailable/);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
