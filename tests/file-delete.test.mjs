import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("file deletion requires explicit confirmation, preserves save guards and refreshes after failures", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { FilePanel } = await server.ssrLoadModule("/src/components/FilePanel.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  const { remoteDirectory } = await server.ssrLoadModule("/src/lib/file-target.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const descriptor = {
    connection: {
      connection_id: "delete",
      workspace_id: "local",
      name: "Delete fixture",
      host: "fixture",
      os: "posix",
      root: "/srv",
    },
    path: "/srv",
    identity: "a".repeat(64),
  };
  let deleted = false;
  let fail = false;
  let finish;
  let guardedAction;
  let reads = 0;
  const writes = [];
  mockIPC((command, args) => {
    if (command === "files_list" || command === "ssh_files_list") {
      reads++;
      return {
        entries: deleted
          ? []
          : [
              { path: "folder", name: "folder", directory: true, symlink: false },
              { path: "file.txt", name: "file.txt", directory: false, symlink: false },
              { path: "link", name: "link", directory: true, symlink: true },
            ],
        partial: false,
        skipped: 0,
      };
    }
    assert.ok(["file_mutate", "ssh_file_mutate"].includes(command));
    writes.push({ command, args });
    if (fail) throw "Permission denied";
    return new Promise((resolve) => {
      finish = () => {
        deleted = true;
        resolve(null);
      };
    });
  });
  const menuFor = async (path) => {
    const row = path
      ? document.querySelector(`.file-row[title="${path}"]`)
      : document.querySelector(".file-results");
    await act(async () =>
      row.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    return [...document.querySelectorAll('[role="menuitem"]')].find((button) =>
      ["删除", "Delete"].includes(button.textContent),
    );
  };
  const click = async (element) => act(async () => element.click());
  const submit = async () =>
    act(async () =>
      document
        .querySelector(".file-management")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
  try {
    for (const directory of ["/fixture", remoteDirectory(descriptor)]) {
      for (const language of ["zh-Hans", "en"]) {
        deleted = false;
        fail = false;
        writes.length = 0;
        await act(async () => {
          setUiLanguage(language);
          root.render(
            React.createElement(FilePanel, {
              key: `${directory}:${language}`,
              directory,
              mode: "tree",
              request: 0,
              resizeHandle: null,
              headerActions: null,
              setMode() {},
              open() {},
              beforeMutation(action) {
                guardedAction = action;
              },
            }),
          );
        });
        assert.equal((await menuFor("")).disabled, true);
        assert.equal((await menuFor("link")).disabled, true);
        await click(await menuFor("folder"));
        const message = document.querySelector(".file-management p").textContent;
        assert.match(message, /folder/);
        assert.match(
          message,
          language === "en" ? /all its subdirectories and files/ : /全部子目录和文件/,
        );
        assert.match(message, language === "en" ? /cannot be undone/ : /无法撤销/);
        assert.equal(writes.length, 0);
        await click(document.querySelector('.file-management button[type="button"]'));
        assert.equal(document.querySelector(".file-management"), null);
        assert.equal(writes.length, 0);
        await click(await menuFor("file.txt"));
        assert.match(document.querySelector(".file-management p").textContent, /file\.txt/);
        assert.doesNotMatch(
          document.querySelector(".file-management p").textContent,
          /subdirectories|子目录/,
        );
        await click(document.querySelector('.file-management button[type="button"]'));
        await click(await menuFor("folder"));
        await submit();
        assert.equal(writes.length, 0);
        fail = true;
        const previousReads = reads;
        await act(async () => guardedAction());
        assert.equal(writes.length, 1);
        assert.ok(reads > previousReads);
        assert.match(document.querySelector('[role="alert"]').textContent, /Permission denied/);
        assert.ok(document.querySelector(".file-management"));
        fail = false;
        await submit();
        await act(async () => guardedAction());
        assert.equal(writes.length, 2);
        const write = writes.at(-1);
        assert.deepEqual(write.args, {
          ...(directory === "/fixture" ? { directory } : { root: descriptor }),
          path: "folder",
          action: "delete",
          name: "",
        });
        assert.equal(write.command, directory === "/fixture" ? "file_mutate" : "ssh_file_mutate");
        assert.ok(
          [...document.querySelectorAll(".file-management button")].every((b) => b.disabled),
        );
        await submit();
        assert.equal(writes.length, 2);
        await act(async () => finish());
        assert.equal(document.querySelector(".file-management"), null);
        assert.equal(document.querySelector('.file-row[title="folder"]'), null);
      }
    }
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
