import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("automatic updates download and install once, preserve file guards and stop after failure", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.isTauri = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
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
    const { UpdateInstallDialog } = await server.ssrLoadModule(
      "/src/components/UpdateInstallDialog.tsx",
    );
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
    const calls = [];
    let updates;
    let automatic = false;
    let rejectPrepare = true;
    let corruptCache = false;
    mockIPC((command) => {
      calls.push(command);
      if (command === "update_status" || command === "update_check")
        return { enabled: true, version: "2.0.0", notes: null, downloaded: false };
      if (command === "update_install" && corruptCache) throw new Error("DOWNLOAD_VERIFY");
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
      return updates.confirmation !== null
        ? React.createElement(UpdateInstallDialog, { updates })
        : null;
    }
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(updates.phase, "available");
    assert.ok(!calls.includes("update_download"));
    automatic = true;
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(updates.phase, "ready");
    assert.equal(updates.confirmation, 10);
    assert.equal(calls.filter((item) => item === "prepare").length, 0);
    assert.ok(document.querySelector("dialog").open);
    assert.equal(document.activeElement.tagName, "BUTTON");
    await act(async () => document.querySelector("dialog button").click());
    await act(async () => t.mock.timers.tick(20_000));
    assert.equal(updates.confirmation, null);
    assert.ok(!calls.includes("update_install"));
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(updates.confirmation, null);
    await act(async () => updates.install());
    await act(async () => t.mock.timers.tick(9999));
    assert.equal(calls.filter((item) => item === "prepare").length, 0);
    await act(async () => t.mock.timers.tick(1));
    assert.match(updates.error, /unsaved file/);
    assert.equal(calls.filter((item) => item === "update_download").length, 1);
    assert.equal(calls.filter((item) => item === "prepare").length, 1);
    assert.ok(calls.includes("restore"));
    assert.ok(!calls.includes("update_install"));
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(calls.filter((item) => item === "prepare").length, 1);
    rejectPrepare = false;
    await act(async () => updates.install());
    await act(async () => {
      await updates.confirmInstall();
      await updates.confirmInstall();
    });
    await act(async () => t.mock.timers.tick(20_000));
    assert.equal(calls.filter((item) => item === "update_install").length, 1);
    await act(async () => updates.check());
    corruptCache = true;
    await act(async () => updates.install());
    await act(async () => updates.confirmInstall());
    assert.equal(updates.phase, "available");
    assert.ok(updates.error);
    const attempts = calls.filter((item) => item === "update_download").length;
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(calls.filter((item) => item === "update_download").length, attempts);
    await act(async () => updates.download());
    assert.equal(updates.phase, "ready");
  } finally {
    await act(async () => root.unmount());
    t.mock.timers.reset();
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
