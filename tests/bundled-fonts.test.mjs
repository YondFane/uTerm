import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";

const directory = new URL("../src/assets/fonts/", import.meta.url);
test("bundled Cascadia faces retain official bytes, styles and redistribution license", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", directory)));
  assert.equal(manifest.family, "Cascadia Code");
  assert.equal(manifest.source, "https://github.com/microsoft/cascadia-code/releases/tag/v2407.24");
  assert.equal(Object.keys(manifest.files).length, 5);
  const css = readFileSync(new URL("fonts.css", directory), "utf8");
  for (const [name, digest] of Object.entries(manifest.files)) {
    const bytes = readFileSync(new URL(name, directory));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
    assert.equal(bytes.readUInt32BE(0), 0x10000);
    assert.ok(css.includes(`./${name}`), name);
  }
  const license = readFileSync(new URL("LICENSE", directory), "utf8");
  assert.match(license, /SIL OPEN FONT LICENSE Version 1.1/);
  assert.match(license, /Microsoft/);
});

test("font readiness holds the terminal until loading, exposes failures and retries without remounting", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const pending = Promise.withResolvers();
  let attempts = 0,
    mounts = 0;
  Object.defineProperty(document, "fonts", {
    value: {
      load: async (font) => {
        assert.equal(font, '14px "Cascadia Code"');
        attempts++;
        if (attempts === 1) return pending.promise;
        return attempts === 2 ? [] : [{}];
      },
    },
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { BundledFontReady } = await server.ssrLoadModule("/src/components/BundledFontReady.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  function Terminal() {
    React.useEffect(() => {
      mounts++;
    }, []);
    return React.createElement("div", { "data-terminal": true }, "Retained terminal");
  }
  try {
    await act(async () =>
      root.render(React.createElement(BundledFontReady, null, React.createElement(Terminal))),
    );
    assert.equal(mounts, 0);
    assert.equal(!!document.querySelector('[role="status"]'), true);
    await act(async () => pending.reject(Error("Font loading denied")));
    assert.equal(mounts, 0);
    assert.match(document.querySelector('[role="alert"]').textContent, /Retry or reinstall/);
    await act(async () => document.querySelector("button").click());
    assert.equal(mounts, 0);
    assert.equal(!!document.querySelector('[role="alert"]'), true);
    await act(async () => document.querySelector("button").click());
    assert.equal(mounts, 1);
    assert.equal(!!document.querySelector("[data-terminal]"), true);
    assert.equal(document.querySelector('[role="alert"]'), null);
    await act(async () =>
      root.render(React.createElement(BundledFontReady, null, React.createElement(Terminal))),
    );
    assert.equal(mounts, 1);
    assert.equal(attempts, 3);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
