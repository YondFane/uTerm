import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";

test("reminder ignores blank clicks and Escape; only button or timeout dismisses", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  let root;
  try {
    const { createRoot } = await import("react-dom/client");
    const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
    const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
    const { BreakReminder } = await server.ssrLoadModule("/src/components/BreakReminder.tsx");
    localStorage.setItem(
      settingsKey,
      JSON.stringify({ ...defaults, breakReminder: true, breakInterval: 1 }),
    );
    t.mock.timers.enable({ apis: ["setTimeout"] });
    root = createRoot(document.getElementById("root"));
    await act(async () =>
      root.render(React.createElement(SettingsProvider, null, React.createElement(BreakReminder))),
    );
    const reminder = () => document.querySelector(".break-reminder");
    await act(async () => t.mock.timers.tick(60000));
    assert.ok(reminder());
    for (const target of [document.body, reminder(), reminder().querySelector("p")]) {
      await act(async () => {
        for (const type of ["pointerdown", "pointerup", "click"])
          target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 0 }));
      });
      assert.ok(reminder());
    }
    await act(async () =>
      document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.ok(reminder());
    await act(async () => t.mock.timers.tick(9999));
    assert.ok(reminder());
    await act(async () => t.mock.timers.tick(1));
    assert.equal(reminder(), null);
    await act(async () => t.mock.timers.tick(60000));
    assert.ok(reminder());
    await act(async () => reminder().querySelector("button").click());
    assert.equal(reminder(), null);
  } finally {
    if (root) await act(async () => root.unmount());
    t.mock.timers.reset();
    await server.close();
    dom.window.close();
  }
});
