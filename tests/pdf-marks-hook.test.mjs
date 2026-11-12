import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";

test("PDF annotation UI retains failures, blocks rapid duplicate writes and ignores an older document's delayed result", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({ configFile: false });
  const { usePdfMarks } = await server.ssrLoadModule("/src/lib/usePdfMarks.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  let ui;
  let finish;
  let fail = true;
  const states = new Map();
  const mark = { id: "one", page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.2 };
  window.utermContentDocument = "pdf-hook";
  window.webkit = {
    messageHandlers: {
      utermContent: {
        async postMessage(message) {
          calls.push(message);
          const key = message.params.version;
          let state = states.get(key) ?? { revision: "a".repeat(64), marks: [] };
          if (message.method === "pdf_marks_write") {
            if (fail)
              return {
                version: 1,
                id: message.id,
                document: message.document,
                error: { code: "IO", message: "Disk busy" },
              };
            await new Promise((resolve) => {
              finish = resolve;
            });
            state = { revision: "b".repeat(64), marks: structuredClone(message.params.marks) };
            states.set(key, state);
          } else assert.equal(message.method, "pdf_marks_read");
          return {
            version: 1,
            id: message.id,
            document: message.document,
            result: structuredClone(state),
          };
        },
      },
    },
  };
  function Harness({ version }) {
    ui = usePdfMarks({ directory: "/qa", path: "test.pdf", version }, true);
    return React.createElement(
      "output",
      { "data-busy": ui.busy, "data-pending": ui.pending },
      JSON.stringify(ui.marks) + ui.error,
    );
  }
  try {
    await act(async () => root.render(React.createElement(Harness, { version: "a".repeat(64) })));
    assert.equal(ui.ready, true);
    await act(async () => ui.add(mark));
    assert.match(ui.error, /Disk busy/);
    assert.equal(ui.pending, true);
    assert.deepEqual(ui.marks, []);
    fail = false;
    let retried;
    await act(async () => {
      retried = ui.retry();
      await new Promise((done) => setTimeout(done, 0));
    });
    assert.equal(ui.busy, true);
    assert.deepEqual(ui.marks, []);
    await act(async () => {
      finish();
      await retried;
    });
    assert.deepEqual(ui.marks, [mark]);
    assert.equal(ui.pending, false);
    await act(async () => root.render(React.createElement(Harness, { version: "c".repeat(64) })));
    const before = calls.filter((call) => call.method === "pdf_marks_write").length;
    let pending;
    await act(async () => {
      pending = ui.add({ ...mark, id: "old-document" });
      void ui.add({ ...mark, id: "duplicate" });
      await new Promise((done) => setTimeout(done, 0));
    });
    assert.equal(calls.filter((call) => call.method === "pdf_marks_write").length, before + 1);
    assert.equal(ui.busy, true);
    await act(async () => root.render(React.createElement(Harness, { version: "d".repeat(64) })));
    assert.equal(ui.busy, false);
    assert.deepEqual(ui.marks, []);
    await act(async () => {
      finish();
      await pending;
    });
    assert.deepEqual(ui.marks, []);
    assert.equal(ui.error, "");
    assert.equal(states.get("c".repeat(64)).marks[0].id, "old-document");
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
