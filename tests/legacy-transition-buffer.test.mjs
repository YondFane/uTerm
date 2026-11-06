import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import React, { act, useRef } from "react";
import { renderedText } from "../scripts/fixtures/legacy-transition-buffer.ts";

const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Text"])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");

test("historical QA reads a real React xterm ref when canvas output has no DOM text", async () => {
  const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 3 });
  const marker = "LEGACY_BEFORE_0123456789abcdef0123456789abcdef";
  await new Promise((done) => terminal.write(marker, done));
  function HistoricalView() {
    useRef(terminal);
    return React.createElement("section", { id: "historical" });
  }
  const root = createRoot(document.getElementById("root"));
  try {
    await act(() => root.render(React.createElement(HistoricalView)));
    const section = document.getElementById("historical");
    assert.equal(section.textContent, "");
    assert.equal(renderedText(section).replace(/\s/g, ""), marker);
    assert.equal(renderedText(document.createElement("section")), "");
    assert(!renderedText(section).includes("LEGACY_ROLLBACK_"));
  } finally {
    await act(() => root.unmount());
    terminal.dispose();
    dom.window.close();
  }
});
