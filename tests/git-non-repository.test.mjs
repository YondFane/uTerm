import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Git and GitHub clear old repository data, hide plain-directory diagnostics and recover", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { GitPanel } = await server.ssrLoadModule("/src/components/GitPanel.tsx");
  const { GitHubPanel } = await server.ssrLoadModule("/src/components/GitHubPanel.tsx");
  const { BranchSelector } = await server.ssrLoadModule("/src/components/BranchSelector.tsx");
  const { useGitFileStatus } = await server.ssrLoadModule("/src/lib/useGitFileStatus.ts");
  function FileStatusProbe({ directory }) {
    const { error } = useGitFileStatus(directory, true, 0);
    return error ? React.createElement("p", { role: "alert" }, error) : null;
  }
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  let failure = "";
  mockIPC((command) => {
    if (failure) throw new Error(failure);
    if (command === "git_branches") return { current: "main", local: ["main"] };
    if (command === "git_file_status") return null;
    if (command === "git_snapshot")
      return {
        root: "/repo",
        branch: "main",
        references: ["main"],
        changes: [{ path: "old-file.txt", original: null, index: " ", working: "M" }],
        truncated: false,
      };
    if (command === "git_references")
      return {
        repository: "/repo/.git",
        current: "main",
        remotes: [],
        references: [
          {
            kind: "local",
            name: "old-branch",
            full_name: "refs/heads/old-branch",
            oid: "a".repeat(40),
            current: false,
          },
        ],
      };
    if (command === "git_remote_branches") return { branches: [], errors: [] };
    if (command === "git_history") return [];
    if (command === "github_repositories") return ["owner/old-repo"];
    if (command === "github_read") return [];
    throw new Error(command);
  });
  const render = (directory) =>
    act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(GitPanel, {
            directory,
            expanded: false,
            resizeHandle: null,
            headerActions: null,
            onExpandedChange() {},
          }),
          React.createElement(GitHubPanel, {
            directory,
            resizeHandle: null,
            headerActions: null,
            associate() {},
            canAssociate: false,
            insert: async () => {},
            canInsert: false,
            createSession() {},
          }),
          React.createElement(BranchSelector, {
            directory,
            disabled: false,
            beforeSwitch() {},
            onChanged() {},
            onError() {},
          }),
          React.createElement(FileStatusProbe, { directory }),
        ),
      ),
    );
  try {
    await render("/repo");
    assert.match(document.body.textContent, /old-file.txt/);
    assert.match(document.body.textContent, /old-branch/);
    assert.ok(document.querySelector('[aria-label="GitHub repository"]'));
    assert.ok(document.querySelector(".workspace-branch"));
    failure = "fatal: not a git repository (or any of the parent directories): .git";
    await render("/plain");
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.equal(document.querySelector(".workspace-branch"), null);
    assert.doesNotMatch(document.body.textContent, /fatal:|old-file|old-branch|old-repo/);
    const history = [...document.querySelectorAll('[role="tab"]')].find(
      (node) => node.textContent === "History",
    );
    await act(async () => history.click());
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.doesNotMatch(document.body.textContent, /fatal:/);
    failure = "Permission denied";
    await render("/denied");
    assert.match(
      document.querySelector('.github-panel [role="alert"]').textContent,
      /Permission denied/,
    );
    assert.match(document.querySelector(".git-tree-error").textContent, /Permission denied/);
    failure = "";
    await render("/repo-again");
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.match(document.body.textContent, /old-branch/);
    assert.ok(document.querySelector('[aria-label="GitHub repository"]'));
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
