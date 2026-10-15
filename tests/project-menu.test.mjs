import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";

test("project actions copy paths and expand workspace choices with keyboard and edge handling", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    const { ProjectMenuActions } = await server.ssrLoadModule(
      "/src/components/ProjectMenuActions.tsx",
    );
    const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
    let copied,
      moved,
      closed = 0,
      created = 0,
      failCopy = false;
    const errors = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          if (failCopy) throw new Error("Clipboard unavailable");
          copied = text;
        },
      },
    });
    const workspaces = [
      { id: "two", name: "后台2" },
      { id: "three", name: "后台3" },
    ];
    const props = {
      directory: "/项目/a b",
      workspaces,
      creatingWorktree: false,
      createWorktree: () => created++,
      move: (id) => (moved = id),
      close: () => closed++,
      onError: (error) => errors.push(error),
    };
    const render = (extra = {}) =>
      act(async () => root.render(React.createElement(ProjectMenuActions, { ...props, ...extra })));
    const button = (text) =>
      [...document.querySelectorAll("button")].find((item) => item.textContent.startsWith(text));
    const key = (element, value) =>
      act(async () =>
        element.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
        ),
      );
    await act(async () => setUiLanguage("zh-Hans"));
    await render();
    assert.equal(button("新建终端"), undefined);
    assert.equal(button("刷新 Worktree"), undefined);
    assert.equal(button("后台2"), undefined);
    await act(async () => button("复制项目地址").click());
    assert.equal(copied, "/项目/a b");
    assert.equal(closed, 1);
    failCopy = true;
    await act(async () => button("复制项目地址").click());
    assert.match(errors[0], /Clipboard unavailable/);
    const trigger = button("移动到工作空间");
    trigger.getBoundingClientRect = () => ({ left: 900, right: 1000, top: 740 });
    await key(trigger, "ArrowRight");
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(document.activeElement.textContent, "后台2");
    const menu = document.querySelector('[role="menu"]');
    assert.ok(Number.parseFloat(menu.style.left) < 900);
    assert.ok(Number.parseFloat(menu.style.top) < 740);
    await key(document.activeElement, "ArrowDown");
    assert.equal(document.activeElement.textContent, "后台3");
    await key(document.activeElement, "Escape");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, trigger);
    assert.equal(closed, 2);
    await act(async () => trigger.click());
    await act(async () => button("后台3").click());
    assert.equal(moved, "three");
    assert.equal(closed, 3);
    await act(async () => button("新建 Worktree").click());
    assert.equal(created, 1);
    await render({ workspaces: [] });
    assert.equal(trigger.disabled, true);
    await act(async () => setUiLanguage("en"));
    assert.ok(button("Copy project path"));
    assert.equal(button("Move to workspace").title, "No other workspaces");
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
