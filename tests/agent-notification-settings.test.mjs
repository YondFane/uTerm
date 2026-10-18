import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Agent notification opt-in uses native permissions and preserves preferences on errors", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  window.Notification = {
    permission: "denied",
    requestPermission: () => {
      throw Error("WebView permission must not control native notifications");
    },
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const setItem = dom.window.Storage.prototype.setItem;
  const calls = [];
  let permission = true;
  let requested = "granted";
  let failure = "";
  let pending;
  mockIPC((command) => {
    calls.push(command);
    if (command === "plugin:notification|is_permission_granted") {
      if (failure) throw Error(failure);
      return permission;
    }
    if (command === "plugin:notification|request_permission") {
      if (requested === "pending") return new Promise((resolve) => (pending = resolve));
      return requested;
    }
    throw Error(`Unexpected command: ${command}`);
  });
  try {
    const { AgentSettings, notificationKey } = await server.ssrLoadModule(
      "/src/components/AgentPanel.tsx",
    );
    const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
    const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
    let key = 0;
    const mount = async (language = "en") => {
      localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language }));
      await act(async () =>
        root.render(
          React.createElement(
            SettingsProvider,
            { key: key++ },
            React.createElement(AgentSettings, {
              runtime: { platform: "windows", agents: [], agent_definitions: [], debug: false },
              reload: async () => {},
            }),
          ),
        ),
      );
    };
    const toggle = () => document.querySelector(".notification-toggle input");
    const click = () => act(async () => toggle().click());
    const alert = () => document.querySelector('[role="alert"]');
    await mount();
    assert.equal(toggle().checked, false);
    await click();
    assert.equal(toggle().checked, true);
    assert.equal(localStorage.getItem(notificationKey), "true");
    assert.deepEqual(calls, ["plugin:notification|is_permission_granted"]);
    assert.equal(alert(), null);
    await mount();
    assert.equal(toggle().checked, true);
    calls.length = 0;
    await click();
    assert.equal(toggle().checked, false);
    assert.equal(localStorage.getItem(notificationKey), "false");
    assert.deepEqual(calls, []);
    for (const nativePermission of [false, null]) {
      permission = nativePermission;
      calls.length = 0;
      await click();
      assert.equal(toggle().checked, true);
      assert.deepEqual(calls, [
        "plugin:notification|is_permission_granted",
        "plugin:notification|request_permission",
      ]);
      await click();
    }
    for (const language of ["en", "zh-Hans"]) {
      await mount(language);
      requested = "denied";
      await click();
      assert.equal(toggle().checked, false);
      assert.equal(localStorage.getItem(notificationKey), "false");
      assert.match(
        alert().textContent,
        language === "en" ? /Notifications are disabled/ : /通知权限未开启/,
      );
    }
    failure = "Native permission failed";
    await click();
    assert.match(alert().textContent, /Native permission failed/);
    assert.equal(toggle().checked, false);
    failure = "";
    permission = true;
    dom.window.Storage.prototype.setItem = () => {
      throw Error("Storage denied");
    };
    await click();
    assert.match(alert().textContent, /Storage denied/);
    assert.equal(toggle().checked, false);
    dom.window.Storage.prototype.setItem = setItem;
    permission = false;
    requested = "pending";
    await click();
    assert.equal(toggle().disabled, true);
    assert.equal(toggle().checked, false);
    assert.equal(localStorage.getItem(notificationKey), "false");
    await act(async () => pending("granted"));
    assert.equal(toggle().disabled, false);
    assert.equal(toggle().checked, true);
    assert.equal(alert(), null);
    assert.equal(localStorage.getItem(notificationKey), "true");
  } finally {
    dom.window.Storage.prototype.setItem = setItem;
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
