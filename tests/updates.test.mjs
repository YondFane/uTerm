import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("automatic updates download and install once, preserve file guards and stop after failure", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.isTauri = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    const { useUpdates } = await server.ssrLoadModule("/src/lib/useUpdates.ts");
    const calls = [];
    let updates;
    let automatic = false;
    let rejectPrepare = true;
    mockIPC((command) => {
      calls.push(command);
      if (command === "update_status")
        return { enabled: true, version: "2.0.0", notes: null, downloaded: false };
    });
    function Harness() {
      updates = useUpdates(
        async () => {
          calls.push("prepare");
          if (rejectPrepare) throw new Error("unsaved file");
        },
        async () => {
          calls.push("restore");
        },
        automatic,
      );
      return null;
    }
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(updates.phase, "available");
    assert.ok(!calls.includes("update_download"));
    automatic = true;
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(updates.phase, "ready");
    assert.match(updates.error, /unsaved file/);
    assert.equal(calls.filter((item) => item === "update_download").length, 1);
    assert.equal(calls.filter((item) => item === "prepare").length, 1);
    assert.ok(calls.includes("restore"));
    assert.ok(!calls.includes("update_install"));
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(calls.filter((item) => item === "prepare").length, 1);
    rejectPrepare = false;
    await act(async () => updates.install());
    assert.equal(calls.filter((item) => item === "update_install").length, 1);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
