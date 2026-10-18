import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Git history shows full messages, metadata and files without stale commit responses", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { GitPanel } = await server.ssrLoadModule("/src/components/GitPanel.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const message =
    "feat: commit details\n\nShow the full message.\n显示完整提交信息。\n\n<script>literal text</script>";
  const commits = [
    { id: "a".repeat(40), subject: "feat: commit details", message },
    { id: "b".repeat(40), subject: "Empty commit", message: "Empty commit" },
    {
      id: "c".repeat(40),
      subject: "Unavailable files",
      message: "Unavailable files\n\nKeep metadata visible.",
    },
  ].map((item) => ({
    ...item,
    parents: [],
    author: "Test Author",
    timestamp: "2026-10-18T12:34:56+08:00",
  }));
  const files = [
    { path: "src/中文 file.ts", index: "M", working: " " },
    { path: "new.txt", index: "A", working: " " },
  ];
  const calls = [];
  let pending;
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "git_snapshot")
      return {
        root: args.directory,
        branch: "release",
        head: commits[0].id,
        references: [],
        changes: [],
        truncated: false,
      };
    if (command === "git_history") return commits;
    if (command === "git_files") {
      if (args.reference === commits[0].id) return pending?.promise ?? files;
      if (args.reference === commits[2].id) throw Error("Commit file read failed");
      return [];
    }
    if (command === "git_diff") return { text: "commit file diff", truncated: false };
    throw Error(command);
  });
  const render = (directory = "/repo") =>
    root.render(
      React.createElement(GitPanel, {
        directory,
        expanded: false,
        onExpandedChange() {},
        headerActions: null,
        resizeHandle: null,
      }),
    );
  const click = async (selector) => {
    const button = document.querySelector(selector);
    assert.ok(button, selector);
    await act(async () => button.click());
  };
  try {
    setUiLanguage("en");
    await act(async () => render());
    await click('[role="tab"]:last-child');
    const row = document.querySelector(".git-commit");
    assert.match(row.title, /显示完整提交信息。/);
    assert.match(row.title, new RegExp(commits[0].id));
    assert.match(row.title, /Test Author/);
    await click(".git-commit");
    assert.equal(document.querySelector(".git-commit-message").textContent, message);
    assert.match(document.querySelector(".git-commit-details").textContent, /Test Author/);
    assert.match(
      document.querySelector(".git-commit-details").textContent,
      new RegExp(commits[0].id),
    );
    assert.equal(document.querySelector(".git-commit-details script"), null);
    assert.equal(document.querySelectorAll(".git-file").length, 2);
    assert.match(document.body.textContent, /Changed files \(2\)/);
    await click(".git-file");
    const diff = calls.filter((call) => call.command === "git_diff").at(-1);
    assert.equal(diff.args.reference, commits[0].id);
    assert.equal(diff.args.mode, "commit");
    assert.equal(diff.args.path, files[0].path);
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    assert.equal(document.querySelector(".git-commit-message").textContent, message);
    await click(".history-back");
    assert.equal(document.querySelector(".git-commit-details"), null);
    assert.equal(document.querySelectorAll(".git-commit").length, 3);
    pending = Promise.withResolvers();
    await click(".git-commit");
    assert.equal(document.querySelectorAll(".git-file").length, 0);
    await click(".history-back");
    await click(".git-commit:nth-child(2)");
    assert.match(document.body.textContent, /This commit has no changed files/);
    await act(async () => pending.resolve([{ path: "stale.txt", index: "M", working: " " }]));
    assert.doesNotMatch(document.body.textContent, /stale.txt/);
    pending = undefined;
    await click(".history-back");
    await click(".git-commit:nth-child(3)");
    assert.match(document.querySelector('[role="alert"]').textContent, /Commit file read failed/);
    assert.match(
      document.querySelector(".git-commit-message").textContent,
      /Keep metadata visible/,
    );
    await click(".history-back");
    await click(".git-commit");
    assert.equal(document.querySelector('[role="alert"]'), null);
    await act(async () => setUiLanguage("zh-Hans"));
    assert.match(document.querySelector(".git-commit-details").textContent, /提交信息/);
    assert.match(document.body.textContent, /变动文件（2）/);
    await act(async () => render("/other-repo"));
    assert.equal(document.querySelector(".git-commit-details"), null);
    await act(async () => render("/repo"));
    assert.equal(document.querySelector(".git-commit-details"), null);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
