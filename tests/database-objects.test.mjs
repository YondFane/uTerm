import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";

test("object menus stay within the viewport and operate on lower tables outside the scrolling tree", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { DatabaseObjects } = await server.ssrLoadModule("/src/components/DatabaseObjects.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains("database-object-popup")
      ? { width: 150, height: 100 }
      : originalBounds.call(this);
  };
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  const props = {
    kind: "mysql",
    scopes: { columns: [{ name: "TABLE_CAT" }], rows: [["qa_db"]] },
    disabled: false,
    load: async () => ({
      columns: [{ name: "TABLE_NAME" }, { name: "TABLE_CAT" }],
      rows: Array.from({ length: 40 }, (_, i) => [`table_${i}`, "qa_db"]),
    }),
    perform: (action) => action(),
    open: (object, view) => calls.push([object.name, view]),
    generate: (object) => calls.push([object.name, "select"]),
    refresh() {},
  };
  const render = (extra = {}) =>
    act(async () => root.render(React.createElement(DatabaseObjects, { ...props, ...extra })));
  const click = (target) => act(async () => target.click());
  const popup = () => document.querySelector(".database-object-popup");
  const key = (value) =>
    act(async () =>
      document.activeElement.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: value, bubbles: true }),
      ),
    );
  try {
    await render();
    await click(document.querySelector(".database-tree-scope"));
    const triggers = [...document.querySelectorAll(".database-object-menu")];
    assert.equal(triggers.length, 40);
    triggers[0].getBoundingClientRect = () => ({ left: 200, top: 100, bottom: 124 });
    triggers[39].getBoundingClientRect = () => ({ left: 980, top: 738, bottom: 762 });
    await click(triggers[0]);
    assert.equal(popup().parentElement, document.body);
    assert.equal(popup().style.left, "200px");
    assert.equal(popup().style.top, "124px");
    await click(triggers[39]);
    assert.equal(document.querySelectorAll('[role="menu"]').length, 1);
    assert.equal(triggers[0].getAttribute("aria-expanded"), "false");
    assert.equal(triggers[39].getAttribute("aria-expanded"), "true");
    assert.equal(popup().style.left, "866px");
    assert.equal(popup().style.top, "638px");
    assert.equal(document.activeElement.textContent, "View data");
    await key("ArrowDown");
    assert.equal(document.activeElement.textContent, "View structure");
    await key("End");
    assert.equal(document.activeElement.textContent, "Generate SELECT");
    await key("Escape");
    assert.equal(popup(), null);
    assert.equal(document.activeElement, triggers[39]);
    for (const [index, action] of ["data", "columns", "select"].entries()) {
      await click(triggers[39]);
      await act(async () =>
        popup().dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true })),
      );
      assert.ok(popup());
      await click(popup().querySelectorAll("button")[index]);
      assert.deepEqual(calls.at(-1), ["table_39", action]);
      assert.equal(popup(), null);
    }
    for (const event of ["scroll", "resize", "blur"]) {
      await click(triggers[39]);
      await act(async () => {
        if (event === "scroll") {
          popup().dispatchEvent(new window.Event("scroll"));
          assert.ok(popup(), "Scrolling the menu itself must retain it");
          document.querySelector(".database-object-tree").dispatchEvent(new window.Event("scroll"));
        } else window.dispatchEvent(new window.Event(event));
      });
      assert.equal(popup(), null);
    }
    await click(triggers[39]);
    await render({ visible: false });
    assert.equal(popup(), null);
    await render();
    await click(triggers[39]);
    await render({ disabled: true });
    assert.equal(popup(), null);
    await render();
    await click(triggers[39]);
    await click(document.querySelector(".database-tree-scope"));
    assert.equal(popup(), null);
    await click(document.querySelector(".database-tree-scope"));
    await click(document.querySelector(".database-object-menu"));
    await act(async () => root.unmount());
    assert.equal(popup(), null);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
    HTMLElement.prototype.getBoundingClientRect = originalBounds;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
