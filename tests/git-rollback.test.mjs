import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Git file rollback confirms, protects editor drafts and retains errors across refreshes", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { GitPanel } = await server.ssrLoadModule("/src/components/GitPanel.tsx");
  const { useFileDocument } = await server.ssrLoadModule("/src/lib/useFileDocument.ts");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const tracked = { path: "中文 file.txt", original: null, index: "M", working: "M" };
  const added = { path: "new.txt", original: null, index: "?", working: "?" };
  let changes = [tracked, added];
  let editor,
    finish,
    savedFails = false,
    rollbackFails = false,
    changed = 0;
  const calls = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "git_snapshot")
      return {
        root: "/repo",
        branch: "release",
        head: "a".repeat(40),
        references: ["release", "feature"],
        changes,
        truncated: false,
      };
    if (command === "git_diff") return { text: "file diff", truncated: false };
    if (command === "file_read")
      return {
        kind: "text",
        text: "original",
        version: "a".repeat(64),
        line_ending: "\n",
        bom: false,
        readonly: false,
        notice: null,
      };
    if (command === "file_save") {
      if (savedFails) throw new Error("CONFLICT:File changed externally");
      return "b".repeat(64);
    }
    if (command === "git_rollback_file") {
      if (rollbackFails) throw new Error("rollback failed");
      return new Promise((resolve) => {
        finish = () => {
          changes = changes.filter((change) => change.path !== args.expected.path);
          resolve();
        };
      });
    }
    if (command === "git_files") return [tracked];
    return null;
  });
  function Harness({ directory = "/repo" }) {
    editor = useFileDocument();
    return React.createElement(GitPanel, {
      key: directory,
      directory,
      expanded: false,
      resizeHandle: null,
      headerActions: null,
      disabled: editor.pending || editor.transitioning,
      beforeMutation: (action) => void editor.closeDirectory(directory, action),
      onChanged: () => changed++,
      onExpandedChange() {},
    });
  }
  const rollbacks = () => calls.filter((call) => call.command === "git_rollback_file");
  const button = (label, within = document) =>
    [...within.querySelectorAll("button")].find((item) => item.textContent === label);
  const openMenu = async (path = tracked.path, keyboard = false) => {
    const row = [...document.querySelectorAll(".git-file")].find((item) => item.title === path);
    await act(async () =>
      row.dispatchEvent(
        keyboard
          ? new dom.window.KeyboardEvent("keydown", {
              key: "F10",
              shiftKey: true,
              bubbles: true,
              cancelable: true,
            })
          : new dom.window.MouseEvent("contextmenu", {
              bubbles: true,
              clientX: 9999,
              clientY: 9999,
              cancelable: true,
            }),
      ),
    );
    return row;
  };
  const confirm = () => act(async () => button("Confirm rollback").click());
  try {
    await act(async () => setUiLanguage("en"));
    await act(async () => root.render(React.createElement(Harness)));
    const row = await openMenu();
    const menu = document.querySelector('[role="menu"]');
    assert.equal(menu.getAttribute("aria-label"), "Git file actions");
    assert(Number.parseFloat(menu.style.left) <= window.innerWidth - 220);
    assert.equal(document.activeElement, button("Roll back file"));
    await act(async () =>
      menu.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, row);
    await openMenu(added.path, true);
    await act(async () => button("Roll back file").click());
    assert.match(document.querySelector("dialog").textContent, /deletes the added file/);
    assert.equal(document.activeElement, button("Cancel"));
    await act(async () => button("Cancel").click());
    assert.equal(rollbacks().length, 0);
    assert.equal(document.activeElement.title, added.path);
    await openMenu();
    await act(async () =>
      document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })),
    );
    assert.equal(document.querySelector('[role="menu"]'), null);

    await act(async () => editor.open("/repo", tracked.path));
    await act(async () => editor.change("draft"));
    savedFails = true;
    await openMenu();
    await act(async () => button("Roll back file").click());
    assert.match(
      document.querySelector("dialog").textContent,
      /staged and working changes to HEAD/,
    );
    await confirm();
    assert.equal(rollbacks().length, 0);
    assert.equal(editor.pending, true);
    assert.equal(editor.document.text, "draft");
    await act(async () => editor.cancel());
    savedFails = false;
    await openMenu();
    await act(async () => button("Roll back file").click());
    await confirm();
    assert.equal(editor.document, null);
    assert.equal(editor.transitioning, true);
    assert.equal(rollbacks().length, 1);
    assert.deepEqual(rollbacks()[0].args, {
      directory: "/repo",
      expected: tracked,
      head: "a".repeat(40),
    });
    assert.equal(
      calls.find((call) => call.command === "file_save" && call.args.text === "draft").args.text,
      "draft",
    );
    assert.match(document.querySelector('[role="status"]').textContent, /Rolling back/);
    await openMenu();
    assert.equal(document.querySelector('[role="menu"]'), null);
    await act(async () => finish());
    assert.equal(editor.transitioning, false);
    assert.equal(changed, 1);
    assert.equal(document.querySelectorAll(".git-file").length, 1);

    rollbackFails = true;
    await openMenu(added.path);
    await act(async () => button("Roll back file").click());
    await confirm();
    assert.match(document.querySelector('[role="alert"]').textContent, /rollback failed/);
    await act(async () => window.dispatchEvent(new dom.window.Event("focus")));
    assert.match(document.querySelector('[role="alert"]').textContent, /rollback failed/);
    assert.equal(changed, 2);
    await act(async () => setUiLanguage("zh-Hans"));
    await openMenu(added.path);
    assert.equal(document.querySelector('[role="menuitem"]').textContent, "回滚文件");
    await act(async () => button("回滚文件").click());
    assert.match(document.querySelector("dialog").textContent, /将删除此新增文件/);
    await act(async () =>
      document
        .querySelector("dialog")
        .dispatchEvent(new dom.window.Event("cancel", { cancelable: true })),
    );
    assert.equal(document.querySelector("dialog"), null);

    await act(async () => button("对比").click());
    await act(async () => {
      const picker = document.querySelector("select");
      picker.value = "feature";
      picker.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await openMenu();
    assert.equal(document.querySelector('[role="menu"]'), null);

    await act(async () => button("变更").click());
    await act(async () => editor.open("/repo", added.path));
    await act(async () => editor.change("recovered draft"));
    savedFails = true;
    await openMenu(added.path);
    await act(async () => button("回滚文件").click());
    await act(async () => button("确认回滚").click());
    assert.equal(editor.pending, true);
    const before = rollbacks().length;
    await act(async () => root.render(React.createElement(Harness, { directory: "/other" })));
    savedFails = false;
    await act(async () => editor.discard());
    assert.equal(rollbacks().length, before);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
