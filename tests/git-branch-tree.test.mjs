import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("branch tree previews without switching, isolates late history and applies menus to their target", async () => {
  const dom = new JSDOM('<div id="root"></div><div id="diff-target"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
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
  const oid = "a".repeat(40);
  const ref = (kind, name, extra = {}) => ({
    kind,
    name,
    full_name:
      kind === "head"
        ? "HEAD"
        : `refs/${kind === "local" ? "heads" : kind === "remote" ? "remotes" : "tags"}/${name}`,
    oid,
    current: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    remote: null,
    branch: null,
    ...extra,
  });
  let catalog = {
    repository: "/repo/.git",
    current: "main",
    remotes: ["origin", "upstream"],
    references: [
      ref("head", "HEAD"),
      ref("local", "main", {
        current: true,
        upstream: "refs/remotes/origin/main",
        ahead: 2,
        behind: 1,
      }),
      ref("local", "feature/中文/deep"),
      ref("local", "occupied", { worktree: "C:/other tree" }),
      ref("remote", "origin/main", { remote: "origin", branch: "main" }),
      ref("tag", "versions/v1"),
    ],
  };
  const calls = [];
  const registeredWorktrees = [];
  let worktreeRefreshFails = false;
  let delayed,
    delayedPage,
    failAction = false,
    saveConflict = false,
    guarded = 0,
    changed = 0;
  const commit = (reference, index = 0) => ({
    id: `${reference}-${index}`,
    parents: [],
    subject: `${reference} commit ${index}`,
    author: "Tester",
    timestamp: "2026-10-29T13:00:00Z",
  });
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "git_references") return catalog;
    if (command === "git_remote_branches")
      return {
        branches: [
          { remote: "origin", branch: "unfetched" },
          { remote: "upstream", branch: "main" },
        ],
        errors: [],
      };
    if (command === "git_snapshot")
      return {
        root: "/repo",
        branch: "main",
        head: oid,
        references: ["main"],
        changes: [],
        truncated: false,
      };
    if (command === "git_history") {
      if (args.reference === "refs/heads/feature/中文/deep") {
        delayed = Promise.withResolvers();
        return delayed.promise;
      }
      if (args.reference === "refs/tags/versions/v1" && args.skip) {
        delayedPage = Promise.withResolvers();
        return delayedPage.promise;
      }
      return Array.from({ length: args.skip ? 1 : 100 }, (_, index) =>
        commit(args.reference, index + args.skip),
      );
    }
    if (command === "git_working_comparison")
      return [
        { path: "tracked.txt", index: "M", working: " " },
        { path: "untracked.txt", index: "?", working: "?" },
      ];
    if (command === "git_diff") return { text: `diff ${args.mode}`, truncated: false };
    if (command === "git_files") return [];
    if (command === "worktree_suggestion")
      return { branch: "new-worktree-1", path: "C:/temp/new-worktree-1" };
    if (command === "create_worktree") return [];
    if (command === "git_reference_action") {
      if (failAction) throw new Error("Git operation failed");
      if (args.target.action === "create")
        catalog = {
          ...catalog,
          references: [...catalog.references, ref("local", args.target.name)],
        };
      return null;
    }
    throw new Error(`Unexpected command ${command}`);
  });
  const mutationCalls = () =>
    calls.filter(
      (call) => call.command === "git_reference_action" || call.command === "create_worktree",
    );
  const row = (name) =>
    [...document.querySelectorAll('[role="treeitem"]')].find(
      (button) => button.dataset.node === name,
    );
  const click = async (element) => {
    assert.ok(element);
    await act(async () => element.click());
  };
  const key = async (element, value, extra = {}) => {
    await act(async () =>
      element.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
          ...extra,
        }),
      ),
    );
  };
  async function menu(name) {
    assert.ok(row(name), name);
    await act(async () =>
      row(name).dispatchEvent(
        new window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 9999,
          clientY: 9999,
        }),
      ),
    );
  }
  const action = (label) =>
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (button) => button.textContent === label,
    );
  async function input(label, value) {
    const element = document.querySelector(`input[aria-label="${label}"]`);
    assert.ok(element, label);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
        element,
        value,
      );
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }
  try {
    await act(async () => {
      setUiLanguage("en");
      root.render(
        React.createElement(GitPanel, {
          directory: "/repo",
          resizeHandle: null,
          headerActions: null,
          expanded: false,
          onExpandedChange() {},
          onChanged: () => changed++,
          onWorktreeCreated: async (root) => {
            registeredWorktrees.push(root);
            if (worktreeRefreshFails) throw new Error("Worktree registration failed");
          },
          beforeMutation: async (run) => {
            guarded++;
            if (!saveConflict) await run();
          },
        }),
      );
    });
    assert.ok(row("refs/remotes/origin/unfetched"));
    assert.equal(row("refs/heads/main").getAttribute("aria-current"), "true");
    assert.match(row("refs/heads/main").textContent, /↑2.*↓1/);
    assert.match(row("refs/heads/occupied").title, /C:\/other tree/);
    await click(row("refs/heads/feature/中文/deep"));
    await act(async () =>
      row("refs/heads/feature/中文/deep").dispatchEvent(
        new window.MouseEvent("dblclick", { bubbles: true }),
      ),
    );
    assert.equal(mutationCalls().length, 0);
    await click(row("refs/tags/versions/v1"));
    const pending = delayed;
    await act(async () => pending.resolve([commit("stale")]));
    assert.doesNotMatch(document.body.textContent, /stale commit/);
    assert.match(document.querySelector(".git-commit").textContent, /refs\/tags\/versions\/v1/);
    assert.ok(document.querySelector(".commit-graph"));
    await click(
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Load earlier commits",
      ),
    );
    assert.equal(calls.filter((call) => call.command === "git_history").at(-1).args.skip, 100);
    await click(row("refs/remotes/origin/unfetched"));
    await act(async () => delayedPage.resolve([commit("stale-page")]));
    assert.doesNotMatch(document.body.textContent, /stale-page/);
    assert.match(document.body.textContent, /Fetch to preview/);
    assert.equal(document.querySelector(".git-commit"), null);
    assert.equal(mutationCalls().length, 0);
    await menu("refs/remotes/origin/unfetched");
    assert.equal(action("New branch").disabled, true);
    await click(action("Fetch this branch"));
    assert.equal(mutationCalls().at(-1).args.target.reference, "refs/remotes/origin/unfetched");
    assert.equal(mutationCalls().at(-1).args.target.action, "fetch");
    await menu("refs/heads/main");
    await click(action("Favorite branch"));
    assert.deepEqual(JSON.parse(window.localStorage.getItem("uterm.git.favorites:/repo/.git")), [
      "refs/heads/main",
    ]);
    await click(row("local/feature"));
    assert.equal(row("refs/heads/feature/中文/deep"), undefined);
    await input("Search branches or tags", "FEATURE/中文");
    assert.ok(row("refs/heads/feature/中文/deep"));
    await input("Search branches or tags", "");
    assert.equal(row("refs/heads/feature/中文/deep"), undefined);
    await key(row("local/feature"), "ArrowRight");
    await key(row("local/feature"), "ArrowRight");
    assert.equal(document.activeElement.dataset.node, "local/feature/中文");
    await key(row("refs/heads/main"), "F10", { shiftKey: true });
    assert.equal(
      document.querySelector('[role="menu"]').getAttribute("aria-label"),
      "Reference actions",
    );
    await key(document.activeElement, "End");
    assert.equal(document.activeElement.textContent, "Copy name");
    await key(document.activeElement, "Escape");
    assert.equal(document.activeElement, row("refs/heads/main"));
    await menu("refs/heads/occupied");
    assert.equal(action("Rename branch").disabled, true);
    assert.equal(action("Switch to this branch").disabled, true);
    await menu("refs/tags/versions/v1");
    await click(action("New branch"));
    await input("Branch name", "created/中文");
    await act(async () =>
      document
        .querySelector("dialog form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(mutationCalls().at(-1).args.target.reference, "refs/tags/versions/v1");
    assert.equal(mutationCalls().at(-1).args.target.action, "create");
    assert.equal(row("refs/heads/created/中文").getAttribute("aria-selected"), "true");
    assert.equal(catalog.current, "main");
    await menu("refs/heads/main");
    await click(action("Compare with working directory"));
    await click(document.querySelector(".git-file"));
    assert.equal(
      calls.filter((call) => call.command === "git_diff").at(-1).args.mode,
      "reference-working",
    );
    await click(
      [...document.querySelectorAll(".git-file")].find((button) =>
        button.textContent.includes("untracked.txt"),
      ),
    );
    assert.equal(calls.filter((call) => call.command === "git_diff").at(-1).args.mode, "working");
    await menu("refs/heads/main");
    await click(action("New worktree"));
    assert.equal(
      document.querySelector('input[aria-label="Worktree directory"]').value,
      "C:/temp/new-worktree-1",
    );
    await act(async () =>
      document
        .querySelector("dialog form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(mutationCalls().at(-1).command, "create_worktree");
    assert.equal(mutationCalls().at(-1).args.reference, "refs/heads/main");
    assert.deepEqual(registeredWorktrees, ["/repo"]);
    worktreeRefreshFails = true;
    await menu("refs/heads/main");
    await click(action("New worktree"));
    await act(async () =>
      document
        .querySelector("dialog form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.match(
      document.querySelector(".git-tree-error").textContent,
      /Worktree registration failed/,
    );
    assert.equal(guarded, 0);
    saveConflict = true;
    await menu("refs/heads/created/中文");
    const before = mutationCalls().length;
    await click(action("Switch to this branch"));
    assert.equal(guarded, 1);
    assert.equal(mutationCalls().length, before);
    saveConflict = false;
    failAction = true;
    await menu("refs/heads/created/中文");
    catalog = { ...catalog, current: "external-change" };
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    await click(action("Switch to this branch"));
    assert.equal(mutationCalls().at(-1).args.target.current, "main");
    assert.match(document.querySelector(".git-tree-error").textContent, /Git operation failed/);
    assert.ok(changed >= 4);
    await act(async () => setUiLanguage("zh-Hans"));
    await menu("refs/heads/main");
    assert.ok(action("与工作目录比较"));
    assert.ok(action("设置上游") || action("更换上游"));
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
