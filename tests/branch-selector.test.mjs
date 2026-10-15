import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("branch dropdown preserves editor changes, serializes switching and ignores stale responses", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    const { BranchSelector } = await server.ssrLoadModule("/src/components/BranchSelector.tsx");
    const { useFileDocument } = await server.ssrLoadModule("/src/lib/useFileDocument.ts");
    const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
    const calls = [];
    let branch = "main";
    let saveFails = false;
    let switchFails = false;
    let actionFails = false;
    let noUpstream = false;
    let remoteErrors = [];
    let finishSwitch;
    let finishPoll;
    let holdPoll = false;
    let editor;
    let changed = 0;
    const errors = [];
    mockIPC((command, args) => {
      calls.push({ command, args });
      if (command === "git_branches") {
        if (args.directory === "/outside") return { current: null, local: [] };
        if (holdPoll) return new Promise((resolve) => (finishPoll = resolve));
        return {
          current: branch,
          local: [...new Set(["feature/中文", "main", branch])],
          upstream: noUpstream ? null : "origin/" + branch,
        };
      }
      if (command === "git_remote_branches")
        return { branches: [{ remote: "origin", branch: "feature/remote" }], errors: remoteErrors };
      if (command === "git_branch_action") {
        if (actionFails) throw new Error("Authentication failed");
        return null;
      }
      if (command === "git_switch_remote_branch") {
        branch = args.branch;
        return null;
      }
      if (command === "git_switch_branch") {
        if (switchFails) throw new Error("Git refused conflicting changes");
        return new Promise((resolve) => {
          finishSwitch = () => {
            branch = args.branch;
            resolve();
          };
        });
      }
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
        if (saveFails) throw new Error("CONFLICT:File changed externally");
        return "b".repeat(64);
      }
      return null;
    });
    function Harness({ directory = "/repo" }) {
      editor = useFileDocument();
      return React.createElement(BranchSelector, {
        key: directory,
        directory,
        disabled: editor.transitioning || editor.pending,
        beforeSwitch: (action) => void editor.close(action),
        onChanged: () => changed++,
        onError: (error) => errors.push(error),
      });
    }
    const render = (directory = "/repo") =>
      act(async () => root.render(React.createElement(Harness, { directory })));
    const select = () => document.querySelector(".branch-trigger");
    const current = () => select().textContent.replace("⌄", "").trim();
    const choose = async (value) => {
      if (select().disabled) return;
      await act(async () => select().click());
      await act(async () =>
        [...document.querySelectorAll('[role="menuitemradio"]')]
          .find((button) => button.textContent.replace("✓", "").trim() === value)
          ?.click(),
      );
    };
    const switches = () => calls.filter((call) => call.command === "git_switch_branch");
    await act(async () => setUiLanguage("en"));
    await render();
    assert.equal(select().getAttribute("aria-label"), "Switch branch");
    assert.equal(current(), "main");
    await act(async () => setUiLanguage("zh-Hans"));
    assert.equal(select().getAttribute("aria-label"), "切换分支");
    await act(async () => editor.open("/repo", "file.txt"));
    saveFails = true;
    await act(async () => editor.change("draft"));
    await choose("feature/中文");
    assert.equal(switches().length, 0);
    assert.equal(editor.pending, true);
    assert.equal(editor.document.text, "draft");
    await act(async () => editor.cancel());
    assert.equal(current(), "main");
    saveFails = false;
    holdPoll = true;
    await act(async () => window.dispatchEvent(new dom.window.Event("focus")));
    await choose("feature/中文");
    assert.equal(select().disabled, true);
    assert.equal(editor.transitioning, true);
    assert.equal(editor.document, null);
    assert.deepEqual(switches()[0].args, {
      directory: "/repo",
      branch: "feature/中文",
      expected: "main",
    });
    assert.equal(calls.find((call) => call.command === "file_save").args.text, "draft");
    const readsBefore = calls.filter((call) => call.command === "file_read").length;
    await act(async () => editor.open("/repo", "other.txt"));
    assert.equal(calls.filter((call) => call.command === "file_read").length, readsBefore);
    await choose("feature/中文");
    assert.equal(switches().length, 1);
    const stalePoll = finishPoll;
    holdPoll = false;
    await act(async () => finishSwitch());
    assert.equal(current(), "feature/中文");
    assert.equal(select().disabled, false);
    assert.equal(editor.transitioning, false);
    assert.equal(changed, 1);
    await act(async () => stalePoll({ current: "main", local: ["feature/中文", "main"] }));
    assert.equal(current(), "feature/中文");
    holdPoll = false;
    switchFails = true;
    await choose("main");
    assert.equal(current(), "feature/中文");
    assert.match(errors[0], /Git refused/);
    assert.equal(changed, 2);
    await act(async () =>
      select().dispatchEvent(
        new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 99999, clientY: 99999 }),
      ),
    );
    assert.match(document.body.textContent, /Push/);
    const menu = document.querySelector('[role="menu"]');
    assert(Number.parseFloat(menu.style.left) <= window.innerWidth - 300);
    await act(async () =>
      [...menu.querySelectorAll("button")]
        .find((button) => button.textContent.includes("Fetch"))
        .click(),
    );
    assert.equal(
      calls.filter((call) => call.command === "git_branch_action")[0].args.action,
      "fetch",
    );
    await act(async () => select().click());
    assert.match(document.body.textContent, /Local/);
    assert.match(document.body.textContent, /Remote/);
    await act(async () =>
      [...document.querySelectorAll('[role="menuitem"]')]
        .find((button) => button.textContent === "origin/feature/remote")
        .click(),
    );
    assert.equal(current(), "feature/remote");
    assert.equal(
      calls.filter((call) => call.command === "git_switch_remote_branch")[0].args.remote,
      "origin",
    );
    await act(async () => select().click());
    await act(async () =>
      document
        .querySelector('[role="menu"]')
        .dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, select());
    noUpstream = true;
    await act(async () => window.dispatchEvent(new dom.window.Event("focus")));
    await act(async () =>
      select().dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
      ),
    );
    assert(
      [...document.querySelectorAll('[role="menuitem"]')].find((button) =>
        button.textContent.includes("Push"),
      ).disabled,
    );
    actionFails = true;
    await act(async () =>
      [...document.querySelectorAll('[role="menuitem"]')]
        .find((button) => button.textContent.includes("Fetch"))
        .click(),
    );
    assert.match(errors.at(-1), /Authentication failed/);
    remoteErrors = ["upstream: Network unavailable"];
    await act(async () => select().click());
    assert.match(document.querySelector('[role="alert"]').textContent, /Network unavailable/);
    await act(async () =>
      document
        .querySelector('[role="menu"]')
        .dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    saveFails = true;
    await act(async () => editor.open("/repo", "file.txt"));
    await act(async () => editor.change("keep draft"));
    await choose("main");
    assert.equal(editor.pending, true);
    await render("/outside");
    assert.equal(select(), null);
    await act(async () => editor.discard());
    assert.equal(switches().length, 2);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
