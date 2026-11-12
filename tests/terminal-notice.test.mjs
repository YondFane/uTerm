import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("oversized terminal paste notices expire, restart their timer and preserve real errors", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "MutationObserver",
    "localStorage",
  ])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.matchMedia = window.matchMedia;
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");
  globalThis.noticeTerminalClass = class extends Terminal {
    constructor(options) {
      super(options);
      globalThis.noticeTerminal = this;
    }
  };
  globalThis.noticeAddons = Object.assign(
    {},
    ...["fit", "search", "web-links", "webgl"].map((name) =>
      createRequire(import.meta.url)(`@xterm/addon-${name}`),
    ),
  );
  const server = await createServer({
    configFile: false,
    ssr: { noExternal: [/^@xterm\//] },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        name: "notice-test-layout",
        enforce: "pre",
        resolveId(id) {
          if (id === "@xterm/xterm") return "\0notice-terminal";
          if (id.startsWith("@xterm/addon-")) return "\0notice-addons";
          if (id.endsWith("/terminal-resize")) return "\0notice-layout";
        },
        load(id) {
          if (id === "\0notice-terminal")
            return "export const Terminal = globalThis.noticeTerminalClass;";
          if (id === "\0notice-addons")
            return "export const {FitAddon, SearchAddon, WebLinksAddon, WebglAddon} = globalThis.noticeAddons;";
          if (id === "\0notice-layout")
            return `
          export function attachTerminalFit() { return { schedule() {}, cancel() {}, dispose() {} }; }
          export function createTerminalResizeQueue() { return { request() {}, dispose() {} }; }
        `;
        },
      },
    ],
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const writes = [];
  let failWrite = false;
  mockIPC((command, args) => {
    if (command === "session_action" && args.action === "write") {
      if (failWrite) throw new Error("Session write failed");
      writes.push(args.data);
    }
    return null;
  });
  try {
    const { TerminalView } = await server.ssrLoadModule("/src/components/TerminalView.tsx");
    const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
    const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
    const noop = () => {};
    await act(async () =>
      root.render(
        React.createElement(
          SettingsProvider,
          null,
          React.createElement(TerminalView, {
            directory: "/tmp/notice-fixture",
            session: { id: "notice", name: "Notice", shell: "default" },
            active: false,
            visible: false,
            focusRequest: "",
            closeRequest: 0,
            onFocus: noop,
            onClosed: noop,
            onAgentState: noop,
            onDetectedAgent: noop,
            onDragOver: noop,
            onDragLeave: noop,
            onDrop: noop,
            onPaneDragStart: noop,
          }),
        ),
      ),
    );
    await act(async () => setUiLanguage("zh-Hans"));
    const term = globalThis.noticeTerminal;
    term.options.disableStdin = false;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const alert = () => document.querySelector('[role="alert"]')?.textContent;
    const paste = (text = "a".repeat(1024 * 1024 + 1)) => act(async () => term.paste(text));
    const tick = (milliseconds) => act(async () => t.mock.timers.tick(milliseconds));
    await paste();
    assert.equal(alert(), "输入过长，请分段粘贴。");
    assert.equal(writes.length, 0);
    await tick(2999);
    assert.ok(alert());
    await tick(1);
    assert.equal(alert(), undefined);
    await paste();
    await tick(2000);
    await paste();
    await tick(1000);
    assert.ok(alert());
    await tick(1999);
    assert.ok(alert());
    await tick(1);
    assert.equal(alert(), undefined);
    await paste("ok");
    assert.deepEqual(writes, [[111, 107]]);
    await paste();
    failWrite = true;
    await paste("fail");
    assert.equal(alert(), "Error: Session write failed");
    await tick(3000);
    assert.equal(alert(), "Error: Session write failed");
    await paste();
    await act(async () => root.unmount());
    await tick(3000);
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => root.unmount());
    t.mock.timers.reset();
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.noticeTerminal;
    delete globalThis.noticeTerminalClass;
    delete globalThis.noticeAddons;
    delete globalThis.matchMedia;
  }
});
