import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("remote file panels reject stale roots and editor save guards use only SFTP commands", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLDialogElement",
    "Node",
    "localStorage",
  ])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.isTauri = true;
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const { RemoteFiles } = await server.ssrLoadModule("/src/components/RemoteFiles.tsx");
  const { useFileDocument } = await server.ssrLoadModule("/src/lib/useFileDocument.ts");
  const { remoteDirectory } = await server.ssrLoadModule("/src/lib/file-target.ts");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const connection = (id) => ({
    connection_id: id,
    workspace_id: "local",
    name: id,
    host: id,
    os: "posix",
    root: "/srv",
  });
  const descriptor = (id) => ({
    connection: connection(id),
    path: "/srv",
    identity: id.repeat(64),
  });
  let resolveA, resolveB, editor;
  let conflict = false;
  let allowMutation = true;
  const calls = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "ssh_files_open")
      return new Promise((resolve) => {
        if (args.connection.host === "a") resolveA = resolve;
        else resolveB = resolve;
      });
    if (command === "ssh_files_list")
      return {
        entries: [
          {
            path: `${args.root.connection.host}.txt`,
            name: `${args.root.connection.host}.txt`,
            directory: false,
            symlink: false,
          },
        ],
        partial: false,
        skipped: 0,
      };
    if (command === "ssh_file_read")
      return {
        kind: "text",
        text: "original",
        version: "0".repeat(64),
        bom: false,
        line_ending: "\n",
        readonly: false,
        notice: null,
      };
    if (command === "ssh_file_save") {
      if (conflict) throw new Error("CONFLICT:external change");
      return "1".repeat(64);
    }
    if (command === "editor_guard" || command.startsWith("plugin:event|")) return null;
    if (command === "ssh_files_disconnect") return null;
    throw new Error(`Unexpected local/remote command: ${command}`);
  });
  const props = (id) => ({
    key: id,
    connection: connection(id),
    onRoot() {},
    open() {},
    beforeMutation(_directory, action) {
      if (allowMutation) action();
    },
    resizeHandle: null,
    headerActions: null,
    newTerminal() {},
  });
  try {
    await act(async () => root.render(React.createElement(RemoteFiles, props("a"))));
    assert.equal(
      calls.some((call) => call.command === "ssh_files_open"),
      false,
      "Selecting a host does not log in",
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Connect files")
        .click(),
    );
    await act(async () => root.render(React.createElement(RemoteFiles, props("b"))));
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Connect files")
        .click(),
    );
    await act(async () => resolveA(descriptor("a")));
    assert.doesNotMatch(document.body.textContent, /a\.txt/);
    await act(async () => resolveB(descriptor("b")));
    assert.match(document.body.textContent, /b\.txt/);
    assert.doesNotMatch(document.body.textContent, /a\.txt/);
    assert.equal(
      document.querySelectorAll('[role="tab"]').length,
      1,
      "Remote directories expose only the file tree",
    );
    allowMutation = false;
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Disconnect files")
        .click(),
    );
    assert.equal(
      calls.filter((call) => call.command === "ssh_files_disconnect").length,
      0,
      "A pending editor guard blocks disconnection",
    );
    allowMutation = true;
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Disconnect files")
        .click(),
    );
    assert.match(document.body.textContent, /Files not connected/);
    assert.equal(
      calls.filter((call) => call.command === "ssh_files_open").length,
      2,
      "Disconnecting never reconnects automatically",
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Connect files")
        .click(),
    );
    assert.deepEqual(
      calls.filter((call) => call.command === "ssh_files_open").at(-1).args.expected,
      descriptor("b"),
      "Reconnect remains bound to the previously resolved root",
    );
    await act(async () => resolveB(descriptor("b")));
    function EditorHarness() {
      editor = useFileDocument();
      return null;
    }
    await act(async () => root.render(React.createElement(EditorHarness)));
    const directory = remoteDirectory(descriptor("b"));
    await act(async () => editor.open(directory, "b.txt"));
    await act(async () => editor.change("saved remotely"));
    await act(async () => assert.equal(await editor.save(), true));
    const written = calls.find((call) => call.command === "ssh_file_save");
    assert.equal(written.args.root.connection.host, "b");
    assert.equal(written.args.path, "b.txt");
    assert.equal(written.args.expected, "0".repeat(64));
    conflict = true;
    await act(async () => editor.change("retained draft"));
    let switched = false;
    await act(async () =>
      editor.hide(() => {
        switched = true;
      }),
    );
    assert.equal(switched, false);
    assert.equal(editor.pending, true);
    assert.equal(editor.conflict, true);
    assert.equal(editor.document.text, "retained draft");
    const stored = localStorage.getItem("uterm.desktop.editorDraft.v1");
    assert.equal(JSON.parse(stored).directory, directory);
    assert.ok(
      !calls.some((call) => ["files_list", "file_read", "file_save"].includes(call.command)),
    );
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.isTauri;
  }
});

test("transfer progress bursts keep UI updates bounded and retain final bytes on completion or cancellation", async () => {
  const dom = new JSDOM("", { url: "http://localhost/" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const transfers = await server.ssrLoadModule("/src/lib/remote-transfers.ts");
  let settle, args;
  mockIPC((command, payload) => {
    assert.equal(command, "ssh_transfer");
    args = payload;
    return new Promise((resolve, reject) => {
      settle = (cancelled) => (cancelled ? reject("SSH_TRANSFER_CANCELLED") : resolve(null));
    });
  });
  let notifications = 0;
  const unsubscribe = transfers.subscribeTransfers(() => notifications++);
  const root = {
    connection: {
      connection_id: "progress",
      workspace_id: "local",
      name: "progress",
      host: "progress",
      os: "posix",
      root: "/srv",
    },
    path: "/srv",
    identity: "a".repeat(64),
  };
  try {
    for (const cancelled of [false, true]) {
      notifications = 0;
      const result = transfers.startRemoteTransfer(root, "file.bin", "upload", false);
      const originalNow = Date.now;
      try {
        Date.now = () => 1000;
        for (let completed = 1; completed <= 100; completed++)
          args.events.onmessage({ id: args.id, name: "file.bin", completed, total: 100 });
        args.events.onmessage({ id: "another-task", name: "other.bin", completed: 0, total: 1 });
      } finally {
        Date.now = originalNow;
      }
      assert.equal(notifications, 2, "A progress burst only publishes its first update");
      settle(cancelled);
      assert.equal(await result, !cancelled);
      const task = transfers.transferSnapshot().find((item) => item.id === args.id);
      assert.equal(task.completed, 100);
      assert.equal(task.total, 100);
      assert.equal(task.state, cancelled ? "cancelled" : "done");
      assert.equal(notifications, 4, "Settlement flushes the latest bytes before its final state");
    }
  } finally {
    unsubscribe();
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
