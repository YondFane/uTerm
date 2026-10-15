import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("file tree refreshes without overlapping reads and cancels its timer on unmount", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { FilePanel } = await server.ssrLoadModule("/src/components/FilePanel.tsx");
  const { createRoot } = await import("react-dom/client");
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map();
  let next = 0;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 5000) return originalTimeout(callback, delay, ...args);
    const id = ++next;
    timers.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    if (!timers.delete(id)) originalClear(id);
  };
  let resolveRead;
  let calls = 0;
  mockIPC((command) => {
    assert.equal(command, "files_list");
    calls++;
    return new Promise((resolve) => {
      resolveRead = resolve;
    });
  });
  const root = createRoot(document.getElementById("root"));
  const listing = (name) => ({
    entries: [{ path: name, name, directory: false, symlink: false }],
    partial: false,
    skipped: 0,
  });
  try {
    await act(async () =>
      root.render(
        React.createElement(FilePanel, {
          directory: "/fixture",
          mode: "tree",
          request: 0,
          resizeHandle: null,
          headerActions: null,
          setMode() {},
          open() {},
          beforeMutation() {},
        }),
      ),
    );
    assert.equal(calls, 1);
    assert.equal(timers.size, 0);
    await act(async () => resolveRead(listing("before.txt")));
    assert.equal(timers.size, 1);
    const [id, refresh] = [...timers][0];
    timers.delete(id);
    await act(async () => {
      void refresh();
    });
    assert.equal(calls, 2);
    assert.equal(timers.size, 0);
    assert.match(document.body.textContent, /before.txt/);
    await act(async () => resolveRead(listing("after.txt")));
    assert.match(document.body.textContent, /after.txt/);
    assert.doesNotMatch(document.body.textContent, /before.txt/);
    await act(async () => root.unmount());
    assert.equal(timers.size, 0);
  } finally {
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
