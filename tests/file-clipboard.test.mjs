import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import {
  installFileClipboardWriter,
  restoreFileClipboard,
  setFileClipboard,
  useFileClipboard,
} from "../src/lib/file-clipboard.ts";

test("native clipboard serializes copies, restores confirmed sources and survives writer replacement", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  let observed;
  function Clipboard() {
    observed = useFileClipboard();
    return null;
  }
  const initial = { directory: "/first", path: "retained.txt" };
  const first = { directory: "/first", path: "new-a.txt" };
  const second = { directory: "/first", path: "new-b.txt" };
  const requests = [],
    errors = [];
  let remove = () => {};
  try {
    await act(async () => {
      restoreFileClipboard(initial);
      root.render(React.createElement(Clipboard));
    });
    remove = installFileClipboardWriter(
      (value) => {
        const reply = Promise.withResolvers();
        requests.push({ value, ...reply });
        return reply.promise;
      },
      (reason) => errors.push(String(reason)),
    );
    await act(async () => {
      setFileClipboard(first);
      setFileClipboard(second);
    });
    assert.equal(observed, second);
    assert.equal(requests.length, 1);
    await act(async () => requests[0].reject(Error("First copy failed")));
    assert.equal(requests.length, 2);
    assert.equal(observed, second);
    await act(async () => requests[1].reject(Error("Second copy failed")));
    assert.equal(observed, initial);
    assert.equal(errors.length, 2);
    await act(async () => setFileClipboard(first));
    await act(async () => requests[2].resolve());
    await act(async () => setFileClipboard(second));
    await act(async () => requests[3].reject(Error("New copy failed")));
    assert.equal(observed, first);
    await act(async () => setFileClipboard(second));
    await act(async () => restoreFileClipboard(initial));
    await act(async () => requests[4].resolve());
    await act(async () => setFileClipboard(first));
    await act(async () => requests[5].reject(Error("Copy failed after hydration")));
    assert.equal(observed, initial);
    const replacement = installFileClipboardWriter(
      async () => {},
      () => assert.fail(),
    );
    remove();
    await act(async () => setFileClipboard(second));
    assert.equal(observed, second);
    replacement();
    await act(async () => setFileClipboard(null));
    assert.equal(observed, null);
  } finally {
    remove();
    await act(async () => root.unmount());
    restoreFileClipboard(null);
    dom.window.close();
  }
});
