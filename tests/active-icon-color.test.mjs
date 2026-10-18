import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("highlight settings follow palettes, persist custom colors and retain them on save failures", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
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
  try {
    const { SettingsProvider, useSettings } = await server.ssrLoadModule(
      "/src/lib/SettingsContext.tsx",
    );
    const { SettingsPanel } = await server.ssrLoadModule("/src/components/SettingsPanel.tsx");
    const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
    const { interfacePalette, interfaceThemes } = await server.ssrLoadModule(
      "/src/lib/interface-themes.ts",
    );
    mockIPC((command) => {
      if (command === "autostart_configure") return false;
      if (command === "control_status")
        return { enabled: false, directory: "", endpoint: "", port: 0 };
      return null;
    });
    const { activeIconColor, ...old } = defaults;
    localStorage.setItem(settingsKey, JSON.stringify({ ...old, language: "en" }));
    let context;
    let key = 0;
    function Harness() {
      context = useSettings();
      return React.createElement(SettingsPanel, {
        runtime: { platform: "windows", agents: [], agent_definitions: [] },
        updates: { phase: "idle", progress: { downloaded: 0, total: null } },
        close() {},
        reloadAgents: async () => {},
        workspace: null,
        updateWorkspace() {},
      });
    }
    const render = () =>
      act(async () =>
        root.render(React.createElement(SettingsProvider, { key }, React.createElement(Harness))),
      );
    const color = () => document.documentElement.style.getPropertyValue("--ui-active-icon");
    const mode = () =>
      [...document.querySelectorAll("label")]
        .find((label) => label.firstChild.textContent === "Icon highlight")
        .querySelector("select");
    const click = async (text) => {
      const button = [...document.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === text,
      );
      assert.ok(button, text);
      await act(async () => button.click());
    };
    const select = async (value) =>
      act(async () => {
        mode().value = value;
        mode().dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
    await render();
    await click("Appearance");
    const styleCard = (name) =>
      [...document.querySelectorAll(".sidebar-style-option")].find(
        (button) => button.querySelector("strong").textContent === name,
      );
    assert.equal(styleCard("Classic sidebar").getAttribute("aria-pressed"), "true");
    await act(async () => styleCard("Icon navigation sidebar").click());
    assert.equal(context.settings.sidebarStyle, "navigation");
    assert.equal(JSON.parse(localStorage.getItem(settingsKey)).sidebarStyle, "navigation");
    assert.equal(mode().value, "theme");
    assert.equal(document.querySelector('input[type="color"]'), null);
    for (const theme of interfaceThemes)
      for (const appearance of ["dark", "light"]) {
        await act(async () =>
          context.save({ ...context.settings, interfaceTheme: theme.id, appearance }, false),
        );
        assert.equal(color(), interfacePalette(theme.id, appearance === "light").accent);
      }
    await select("custom");
    assert.equal(mode().value, "custom");
    const field = () => document.querySelector('[aria-label="Highlight color value"]');
    await act(async () => {
      field().value = "#6633cc";
      field().dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
    });
    assert.equal(color(), "#6633cc");
    assert.equal(JSON.parse(localStorage.getItem(settingsKey)).activeIconColor, "#6633cc");
    await act(async () =>
      context.save({ ...context.settings, interfaceTheme: "ocean", appearance: "dark" }, false),
    );
    assert.equal(color(), "#6633cc");
    key++;
    await render();
    await click("Appearance");
    assert.equal(styleCard("Icon navigation sidebar").getAttribute("aria-pressed"), "true");
    assert.equal(mode().value, "custom");
    assert.equal(field().value, "#6633cc");
    await act(async () => {
      field().value = "#zzzzzz";
      field().dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
    });
    assert.equal(color(), "#6633cc");
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /Appearance settings are invalid/,
    );
    dom.window.Storage.prototype.setItem = () => {
      throw new Error("Storage denied");
    };
    await act(async () => styleCard("Classic sidebar").click());
    assert.equal(context.settings.sidebarStyle, "navigation");
    assert.equal(styleCard("Icon navigation sidebar").getAttribute("aria-pressed"), "true");
    await select("theme");
    assert.equal(mode().value, "custom");
    assert.equal(color(), "#6633cc");
    assert.match(document.querySelector('[role="alert"]').textContent, /Storage denied/);
    dom.window.Storage.prototype.setItem = setItem;
    await select("theme");
    assert.equal(color(), interfacePalette("ocean", false).accent);
    assert.equal(JSON.parse(localStorage.getItem(settingsKey)).activeIconColor, "");
    await act(async () => context.reset());
    assert.equal(context.settings.sidebarStyle, "classic");
    assert.equal(color(), interfacePalette(defaults.interfaceTheme, false).accent);
  } finally {
    dom.window.Storage.prototype.setItem = setItem;
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
