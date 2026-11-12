import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("expanded folders wait for the refreshed parent before rereading deleted paths", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const server = await createServer({ configFile: false });
  const { FilePanel } = await server.ssrLoadModule("/src/components/FilePanel.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const folder = { path: "folder", name: "folder", directory: true, symlink: false };
  const listing = (entries) => ({ entries, partial: false, skipped: 0 });
  let deleted = false,
    holdParent = false,
    releaseParent,
    denied = false,
    childReads = 0,
    readsAfterDelete = 0;
  mockIPC((command, args) => {
    if (command === "git_file_status") return null;
    if (command === "file_mutate") {
      assert.equal(args.action, "delete");
      assert.equal(args.path, "folder");
      deleted = true;
      holdParent = true;
      return null;
    }
    assert.equal(command, "files_list");
    if (!args.path) {
      if (denied) throw Error("Permission denied for selected root");
      if (holdParent)
        return new Promise((resolve) => {
          releaseParent = resolve;
        });
      return listing(deleted ? [] : [folder]);
    }
    assert.equal(args.path, "folder");
    childReads++;
    if (deleted) {
      readsAfterDelete++;
      throw Error("Could not open file: No such file or directory");
    }
    const name = childReads === 1 ? "before.txt" : "after.txt";
    return listing([{ path: "folder/" + name, name, directory: false, symlink: false }]);
  });
  const click = async (button) =>
    act(async () => {
      assert.ok(button);
      button.click();
    });
  const row = () => document.querySelector('.file-row[data-path="folder"]');
  try {
    await act(async () => {
      setUiLanguage("en");
      root.render(
        React.createElement(FilePanel, {
          directory: "/fixture",
          mode: "tree",
          request: 0,
          resizeHandle: null,
          headerActions: null,
          setMode() {},
          open() {},
          beforeMutation: (action) => action(),
        }),
      );
    });
    await click(row());
    assert.equal(childReads, 1);
    assert.ok(document.querySelector('.file-row[data-path="folder/before.txt"]'));
    holdParent = true;
    await click(document.querySelector('button[aria-label="Refresh files"]'));
    const childReadsWhileParentPending = childReads;
    const cachedSubtreeWhileParentPending = !!document.querySelector(
      '.file-row[data-path="folder/before.txt"]',
    );
    holdParent = false;
    await act(async () => releaseParent(listing([folder])));
    assert.equal(childReads, 2);
    assert.equal(row().getAttribute("aria-expanded"), "true");
    assert.ok(document.querySelector('.file-row[data-path="folder/after.txt"]'));
    await act(async () =>
      row().dispatchEvent(
        new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      ),
    );
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find(
        (button) => button.textContent === "Delete",
      ),
    );
    await act(async () =>
      document
        .querySelector(".file-management")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(deleted, true);
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      "",
      "deleted expanded folder produced a transient error",
    );
    assert.equal(readsAfterDelete, 0, "deleted expanded child was read before parent pruned it");
    holdParent = false;
    await act(async () => releaseParent(listing([])));
    assert.equal(row(), null);
    assert.equal(document.querySelector('[role="alert"]'), null);
    denied = true;
    await click(document.querySelector('button[aria-label="Refresh files"]'));
    assert.equal(childReadsWhileParentPending, 1, "child refresh preceded its parent listing");
    assert.equal(
      cachedSubtreeWhileParentPending,
      true,
      "cached subtree was replaced during refresh",
    );
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /Permission denied/,
      "real parent errors were swallowed",
    );
  } finally {
    holdParent = false;
    if (releaseParent) await act(async () => releaseParent(listing([])));
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    for (const key of [
      "window",
      "document",
      "navigator",
      "HTMLElement",
      "Node",
      "IS_REACT_ACT_ENVIRONMENT",
    ])
      delete globalThis[key];
  }
});
