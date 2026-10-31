import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("file tree Git status shares its root query and protects refresh lifecycle", async (suite) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  let hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { FilePanel } = await server.ssrLoadModule("/src/components/FilePanel.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  const { createRoot } = await import("react-dom/client");
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map();
  let nextTimer = 0;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (![250, 4000, 5000].includes(delay)) return originalTimeout(callback, delay, ...args);
    const token = { timer: ++nextTimer };
    timers.set(token, { delay, callback: () => callback(...args) });
    return token;
  };
  globalThis.clearTimeout = (token) => {
    if (!timers.delete(token)) originalClear(token);
  };
  const change = (path, index = " ", working = "M") => ({
    path,
    index,
    working,
    original: null,
  });
  const snapshot = (directory, changes, truncated = false) => ({
    root: directory,
    changes,
    truncated,
  });
  const listing = (path) => ({
    entries:
      path === ""
        ? [
            { path: "src", name: "src", directory: true, symlink: false },
            { path: "README.md", name: "README.md", directory: false, symlink: false },
          ]
        : path === "src"
          ? [
              { path: "src/nested", name: "nested", directory: true, symlink: false },
              { path: "src/index.ts", name: "index.ts", directory: false, symlink: false },
            ]
          : [
              {
                path: "src/nested/new.ts",
                name: "new.ts",
                directory: false,
                symlink: false,
              },
            ],
    partial: false,
    skipped: 0,
  });
  const row = (path) =>
    [...document.querySelectorAll(".file-row")].find((button) => button.dataset.path === path);
  const timerCount = (delay) =>
    [...timers.values()].filter((timer) => timer.delay === delay).length;
  async function fireTimer(delay) {
    const pending = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(pending, `No pending ${delay}ms timer`);
    timers.delete(pending[0]);
    await act(async () => pending[1].callback());
  }
  async function focused() {
    await act(async () => window.dispatchEvent(new window.Event("focus")));
  }
  async function visibility() {
    await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
  }
  const rootProps = {
    directory: "/repo",
    mode: "tree",
    request: 0,
    resizeHandle: null,
    headerActions: null,
    setMode() {},
    open() {},
    beforeMutation() {},
  };
  async function panelCase(run) {
    hidden = false;
    setUiLanguage("en");
    const calls = [];
    let readGit = ({ directory }) => snapshot(directory, []);
    mockIPC((command, args) => {
      calls.push({ command, args });
      if (command === "git_file_status") return readGit(args);
      if (command === "files_list" || command === "ssh_files_list") return listing(args.path);
      if (command === "files_search") return { matches: [], partial: false, skipped: 0 };
      throw new Error(`Unexpected command: ${command}`);
    });
    const root = createRoot(document.getElementById("root"));
    let mounted = true;
    const props = { ...rootProps };
    const gitCalls = () => calls.filter((call) => call.command === "git_file_status");
    const listCalls = () => calls.filter((call) => call.command === "files_list");
    const render = async (patch = {}) => {
      Object.assign(props, patch);
      await act(async () => root.render(React.createElement(FilePanel, props)));
    };
    const unmount = async () => {
      if (!mounted) return;
      await act(async () => root.unmount());
      mounted = false;
    };
    const refresh = async () => {
      const button = document.querySelector('button[aria-label="Refresh files"]');
      assert.ok(button);
      await act(async () => button.click());
    };
    try {
      await run({
        calls,
        gitCalls,
        listCalls,
        render,
        refresh,
        unmount,
        setReadGit: (next) => {
          readGit = next;
        },
      });
    } finally {
      await unmount();
      assert.equal(timers.size, 0, "Panel timers were retained after unmount");
      clearMocks();
    }
  }
  try {
    await suite.test(
      "collapsed ancestors and expanded children share one status read",
      async () => {
        await panelCase(async ({ setReadGit, render, gitCalls, listCalls, refresh }) => {
          let changes = [change("src/index.ts"), change("src/nested/new.ts", "?", "?")];
          setReadGit(({ directory }) => snapshot(directory, changes));
          await render();
          assert.equal(gitCalls().length, 1);
          assert.equal(row("src").dataset.gitStatus, "modified");
          assert.equal(row("src").querySelector(".file-git-status").textContent, "M");
          assert.match(row("src").getAttribute("aria-label"), /Contains Git changes: Modified/);
          assert.equal(row("src").getAttribute("aria-expanded"), "false");
          assert.equal(row("README.md").hasAttribute("data-git-status"), false);

          await act(async () => row("src").click());
          await act(async () => row("src/nested").click());
          assert.equal(gitCalls().length, 1, "Expanded folders issued their own status reads");
          assert.equal(row("src/index.ts").dataset.gitStatus, "modified");
          assert.equal(row("src/nested").dataset.gitStatus, "untracked");
          assert.equal(row("src/nested/new.ts").querySelector(".file-git-status").textContent, "?");
          assert.match(row("src/index.ts").getAttribute("aria-label"), /Git status: Modified/);

          const expandedChild = row("src/nested/new.ts");
          const readsBeforeStatusRefresh = listCalls().length;
          changes = [];
          await focused();
          assert.equal(gitCalls().length, 2);
          assert.equal(listCalls().length, readsBeforeStatusRefresh);
          assert.equal(row("src/nested/new.ts"), expandedChild);
          assert.equal(row("src").getAttribute("aria-expanded"), "true");
          assert.equal(row("src/nested").getAttribute("aria-expanded"), "true");
          assert.equal(document.querySelectorAll(".file-git-status").length, 0);
          assert.equal(document.querySelectorAll(".file-row[data-git-status]").length, 0);

          changes = [change("src/nested/new.ts", "A", " ")];
          await refresh();
          assert.equal(gitCalls().length, 3);
          assert.equal(row("src/nested/new.ts").dataset.gitStatus, "added");
          assert.equal(row("src/nested/new.ts").querySelector(".file-git-status").textContent, "A");
          assert.equal(row("src").getAttribute("aria-expanded"), "true");
        });
      },
    );

    await suite.test("canceling deletion restores focus to a Git-decorated directory", async () => {
      await panelCase(async ({ setReadGit, render, calls }) => {
        let mutationGuards = 0;
        setReadGit(({ directory }) => snapshot(directory, [change("src/index.ts")]));
        await render({
          beforeMutation() {
            mutationGuards++;
          },
        });
        const directory = row("src");
        assert.equal(directory.dataset.gitStatus, "modified");
        assert.equal(directory.dataset.path, "src");
        assert.notEqual(directory.title, "src");

        for (const cancelWith of ["button", "escape", "native-cancel"]) {
          await act(async () =>
            directory.dispatchEvent(
              new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
            ),
          );
          const remove = [...document.querySelectorAll('[role="menuitem"]')].find(
            (button) => button.textContent === "Delete",
          );
          assert.ok(remove);
          await act(async () => remove.click());
          const dialog = document.querySelector(".file-delete-dialog");
          assert.equal(dialog.open, true);
          const cancel = dialog.querySelector('button[type="button"]');
          assert.equal(cancel.textContent, "Cancel");
          assert.equal(document.activeElement, cancel);

          await act(async () => {
            if (cancelWith === "button") cancel.click();
            else if (cancelWith === "escape")
              cancel.dispatchEvent(
                new window.KeyboardEvent("keydown", {
                  key: "Escape",
                  bubbles: true,
                  cancelable: true,
                }),
              );
            else dialog.dispatchEvent(new window.Event("cancel", { cancelable: true }));
          });
          assert.equal(document.querySelector(".file-delete-dialog"), null, cancelWith);
          assert.equal(document.activeElement, directory, cancelWith);
          assert.equal(row("src"), directory);
          assert.equal(directory.dataset.gitStatus, "modified");
          assert.equal(mutationGuards, 0);
          assert.equal(
            calls.some((call) => ["file_mutate", "ssh_file_mutate"].includes(call.command)),
            false,
          );
        }
      });
    });

    await suite.test("truncation and failed status reads stay visible and recover", async () => {
      await panelCase(async ({ setReadGit, render, refresh, gitCalls }) => {
        setReadGit(({ directory }) => snapshot(directory, [change("README.md")], true));
        await render();
        assert.equal(row("README.md").dataset.gitStatus, "modified");
        assert.match(document.querySelector('[role="status"]').textContent, /2,000/);
        await act(async () => setUiLanguage("zh-Hans"));
        assert.match(document.querySelector('[role="status"]').textContent, /仅标记前 2,000 项/);
        assert.equal(gitCalls().length, 1);
        await act(async () => setUiLanguage("en"));

        setReadGit(() => {
          throw new Error("status fixture failed");
        });
        await refresh();
        assert.match(document.querySelector('[role="alert"]').textContent, /status fixture failed/);
        assert.equal(document.querySelector('[role="status"]'), null);
        assert.equal(document.querySelectorAll(".file-git-status").length, 0);
        assert.ok(row("README.md"));

        setReadGit(() => null);
        await focused();
        assert.equal(document.querySelector('[role="alert"]'), null);
        assert.equal(document.querySelectorAll(".file-row[data-git-status]").length, 0);
      });
    });

    await suite.test("old-root responses cannot replace the current root state", async () => {
      await panelCase(async ({ setReadGit, render, gitCalls }) => {
        const resolve = new Map();
        setReadGit(
          ({ directory }) =>
            new Promise((done) => {
              resolve.set(directory, done);
            }),
        );
        await render({ directory: "/first" });
        await render({ directory: "/second" });
        assert.equal(gitCalls().length, 2);
        assert.equal(timerCount(4000), 0);
        await act(async () =>
          resolve.get("/second")(snapshot("/second", [change("README.md", "A", " ")])),
        );
        assert.equal(row("README.md").dataset.gitStatus, "added");
        assert.equal(timerCount(4000), 1);
        await act(async () =>
          resolve.get("/first")(snapshot("/first", [change("README.md", "U", "U")], true)),
        );
        assert.equal(row("README.md").dataset.gitStatus, "added");
        assert.equal(document.querySelector('[role="status"]'), null);
        assert.equal(timerCount(4000), 1);
      });
    });

    await suite.test("focus, visibility and timers never overlap a pending read", async () => {
      await panelCase(async ({ setReadGit, render, gitCalls, unmount }) => {
        const resolve = [];
        setReadGit(
          () =>
            new Promise((done) => {
              resolve.push(done);
            }),
        );
        await render();
        assert.equal(gitCalls().length, 1);
        assert.equal(timerCount(4000), 0);
        await focused();
        await focused();
        await visibility();
        assert.equal(gitCalls().length, 1);
        await act(async () => resolve[0](snapshot("/repo", [])));
        assert.equal(timerCount(4000), 1);

        await focused();
        assert.equal(gitCalls().length, 2);
        assert.equal(timerCount(4000), 0);
        await focused();
        await visibility();
        assert.equal(gitCalls().length, 2);
        await act(async () => resolve[1](snapshot("/repo", [])));
        assert.equal(timerCount(4000), 1);

        await fireTimer(4000);
        assert.equal(gitCalls().length, 3);
        assert.equal(timerCount(4000), 0);
        await focused();
        assert.equal(gitCalls().length, 3);
        await act(async () => resolve[2](snapshot("/repo", [])));
        hidden = true;
        await fireTimer(4000);
        assert.equal(gitCalls().length, 3);
        assert.equal(timerCount(4000), 1);
        hidden = false;
        await visibility();
        assert.equal(gitCalls().length, 4);
        assert.equal(timerCount(4000), 0);

        await unmount();
        assert.equal(timers.size, 0);
        await act(async () => resolve[3](snapshot("/repo", [change("README.md")])));
        assert.equal(timers.size, 0);
        await focused();
        await visibility();
        assert.equal(gitCalls().length, 4);
      });
    });

    await suite.test(
      "repeated manual refreshes wait for the same root's pending read",
      async () => {
        await panelCase(async ({ setReadGit, render, refresh, gitCalls }) => {
          const resolve = [];
          setReadGit(
            () =>
              new Promise((done) => {
                resolve.push(done);
              }),
          );
          await render();
          assert.equal(gitCalls().length, 1);
          await refresh();
          await refresh();
          assert.equal(gitCalls().length, 1);
          assert.equal(timerCount(4000), 0);
          await act(async () => resolve[0](snapshot("/repo", [change("README.md", "U", "U")])));
          assert.equal(gitCalls().length, 2);
          assert.equal(document.querySelectorAll(".file-git-status").length, 0);
          await act(async () => resolve[1](snapshot("/repo", [change("README.md", "A", " ")])));
          assert.equal(row("README.md").dataset.gitStatus, "added");
          assert.equal(timerCount(4000), 1);
        });
      },
    );

    await suite.test(
      "returning to the tree waits for the same root and ignores stale errors",
      async () => {
        await panelCase(async ({ setReadGit, render, gitCalls }) => {
          const pending = [];
          setReadGit(
            () =>
              new Promise((resolve, reject) => {
                pending.push({ resolve, reject });
              }),
          );
          await render();
          assert.equal(gitCalls().length, 1);
          await render({ mode: "quick" });
          await focused();
          await visibility();
          assert.equal(gitCalls().length, 1);
          assert.equal(timerCount(4000), 0);

          await render({ mode: "tree" });
          await focused();
          await visibility();
          assert.equal(gitCalls().length, 1);
          await act(async () => pending[0].reject(new Error("stale tree read failed")));
          assert.equal(gitCalls().length, 2);
          assert.equal(document.querySelector('[role="alert"]'), null);
          assert.equal(timerCount(4000), 0);

          await act(async () =>
            pending[1].resolve(snapshot("/repo", [change("README.md", "A", " ")])),
          );
          assert.equal(row("README.md").dataset.gitStatus, "added");
          assert.equal(document.querySelector('[role="alert"]'), null);
          assert.equal(timerCount(4000), 1);
        });
      },
    );

    await suite.test("non-tree and SSH views do not query local Git status", async () => {
      await panelCase(async ({ render, gitCalls, calls }) => {
        await render({ mode: "quick" });
        await fireTimer(250);
        assert.equal(gitCalls().length, 0);
        assert.equal(timerCount(4000), 0);
        await render({ mode: "search" });
        await fireTimer(250);
        await focused();
        await visibility();
        assert.equal(gitCalls().length, 0);
        assert.equal(calls.filter((call) => call.command === "files_search").length, 2);

        const remote =
          "uterm-ssh:" +
          encodeURIComponent(
            JSON.stringify({
              connection: {
                connection_id: "fixture",
                workspace_id: "local",
                name: "Fixture",
                host: "fixture.test",
                os: "posix",
                root: "/workspace",
              },
              path: "/workspace",
              identity: "a".repeat(64),
            }),
          );
        await render({ directory: remote, mode: "tree" });
        await focused();
        await visibility();
        assert.equal(gitCalls().length, 0);
        assert.equal(timerCount(4000), 0);
        assert.equal(calls.filter((call) => call.command === "ssh_files_list").length, 1);
        assert.ok(row("src"));
      });
    });
  } finally {
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
