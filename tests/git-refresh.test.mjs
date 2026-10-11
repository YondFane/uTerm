import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Git refresh reads one snapshot per focus event and keeps unchanged-status diffs current", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { GitPanel } = await server.ssrLoadModule("/src/components/GitPanel.tsx");
  const { createRoot } = await import("react-dom/client");
  const timers = new Map();
  let nextTimer = 0;
  window.setInterval = (callback) => {
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  };
  window.clearInterval = (id) => timers.delete(id);
  const originalClear = globalThis.clearInterval;
  globalThis.clearInterval = (id) => {
    if (!timers.delete(id)) originalClear(id);
  };
  let hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  let snapshots = 0;
  let diffs = 0;
  let text = "first diff";
  let failure = false;
  mockIPC((command) => {
    if (command === "git_snapshot") {
      snapshots++;
      if (failure) throw new Error("snapshot failure");
      return {
        root: "/fixture",
        branch: "release",
        references: ["release"],
        changes: [{ path: "file.txt", original: null, index: " ", working: "M" }],
        truncated: false,
      };
    }
    assert.equal(command, "git_diff");
    diffs++;
    return { text, truncated: false };
  });
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () =>
      root.render(
        React.createElement(GitPanel, {
          directory: "/fixture",
          expanded: false,
          resizeHandle: null,
          headerActions: null,
          onExpandedChange() {},
        }),
      ),
    );
    assert.equal(snapshots, 1);
    await act(async () => document.querySelector(".git-file").click());
    assert.equal(diffs, 1);
    text = "updated diff";
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    assert.equal(snapshots, 2);
    assert.equal(diffs, 2);
    assert.match(document.body.textContent, /updated diff/);

    hidden = true;
    await act(async () => {
      document.dispatchEvent(new window.Event("visibilitychange"));
      for (const poll of timers.values()) await poll();
    });
    assert.equal(snapshots, 2);
    hidden = false;
    await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
    assert.equal(snapshots, 3);
    const beforePoll = { snapshots, diffs };
    await act(async () => [...timers.values()][0]());
    assert.equal(snapshots, beforePoll.snapshots + 1);
    assert.equal(diffs, beforePoll.diffs + 1);

    failure = true;
    const beforeFailure = diffs;
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    assert.match(document.querySelector('[role="alert"]').textContent, /snapshot failure/);
    assert.equal(diffs, beforeFailure);
    assert.match(document.body.textContent, /updated diff/);
    failure = false;
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    assert.equal(document.querySelector('[role="alert"]'), null);

    await act(async () => root.unmount());
    assert.equal(timers.size, 0);
    const before = snapshots;
    window.dispatchEvent(new window.Event("focus"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    assert.equal(snapshots, before);
  } finally {
    await act(async () => root.unmount());
    globalThis.clearInterval = originalClear;
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
