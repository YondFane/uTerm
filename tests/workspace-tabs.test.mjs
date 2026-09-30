import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("workspace tabs retain files, guard switching and only offer file close buttons", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const scrolledTabs = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () {
    scrolledTabs.push(this);
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    const { useFileDocument } = await server.ssrLoadModule("/src/lib/useFileDocument.ts");
    const { WorkspaceTabs } = await server.ssrLoadModule("/src/components/WorkspaceTabs.tsx");
    const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
    setUiLanguage("en");
    let editor;
    let limit = 10;
    let selected = "terminal";
    let failSave = false;
    const calls = [];
    mockIPC((command, args) => {
      calls.push({ command, args });
      if (command === "file_read")
        return {
          kind: "text",
          text: `${args.directory}/${args.path}`,
          version: "a".repeat(64),
          line_ending: "\n",
          bom: false,
          readonly: false,
          notice: null,
        };
      if (command === "file_save") {
        if (failSave) throw new Error("CONFLICT:External change");
        return "b".repeat(64);
      }
      return null;
    });
    function Harness() {
      editor = useFileDocument(limit);
      return React.createElement(WorkspaceTabs, {
        sessions: [
          { id: "terminal", name: "Terminal", shell: "default" },
          { id: "claude", name: "Claude", shell: "default", agent: "claude" },
        ],
        documents: editor.documents,
        activeFile: editor.document?.id ?? null,
        activeSession: selected,
        detectedAgents: {},
        disabled: editor.pending || editor.transitioning,
        selectSession: (id) =>
          void editor.hide(() => {
            selected = id;
          }),
        selectFile: (file) => void editor.open(file.directory, file.path),
        closeFile: (id) => void editor.close(undefined, id),
      });
    }
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => editor.open("/repo", "first.txt"));
    const firstId = editor.document.id;
    await act(async () => editor.change("edited first"));
    await act(async () => editor.open("/repo", "second.txt"));
    assert.equal(editor.documents.length, 2);
    assert.equal(editor.documents[0].text, "edited first");
    assert.equal(editor.documents[0].saved, "edited first");
    assert.equal(calls.filter((call) => call.command === "file_save").length, 1);
    await act(async () => editor.open("/repo", "first.txt", 3));
    assert.equal(editor.document.id, firstId);
    assert.equal(editor.document.line, 3);
    assert.equal(calls.filter((call) => call.command === "file_read").length, 2);
    const tabs = () => [...document.querySelectorAll('[role="tab"]')];
    assert.equal(tabs().length, 3);
    assert.ok(!tabs().some((item) => item.textContent === "Claude"));
    selected = "claude";
    await act(async () => root.render(React.createElement(Harness)));
    assert.ok(!tabs().some((item) => item.textContent === "Terminal"));
    assert.ok(tabs().some((item) => item.textContent === "Claude"));
    assert.equal(document.querySelectorAll(".workspace-tab-close").length, 2);
    selected = "terminal";
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(scrolledTabs.at(-1).className, "workspace-tab");
    assert.equal(scrolledTabs.at(-1).querySelectorAll(".workspace-tab-close").length, 1);
    for (const name of ["Terminal"]) {
      const tab = tabs().find((item) => item.textContent === name);
      assert.equal(tab.parentElement.querySelectorAll("button").length, 1);
    }
    assert.equal(document.querySelectorAll(".workspace-tab-close").length, 2);
    await act(async () => editor.change("unsaved conflict"));
    failSave = true;
    await act(async () => tabs()[0].click());
    assert.equal(editor.document.id, firstId);
    assert.equal(editor.pending, true);
    assert.equal(editor.conflict, true);
    assert.equal(editor.document.text, "unsaved conflict");
    await act(async () => editor.cancel());
    await act(async () => editor.close());
    assert.equal(editor.pending, true);
    assert.equal(editor.documents.length, 2);
    await act(async () => editor.cancel());
    await act(async () => editor.hide());
    await act(async () => editor.discard());
    assert.equal(editor.document, null);
    assert.equal(editor.documents[0].text, "edited first");
    assert.equal(document.querySelector('[aria-selected="true"]').textContent, "Terminal");
    failSave = false;
    await act(async () => editor.open("/repo", "first.txt"));
    const secondId = editor.documents.find((item) => item.path === "second.txt").id;
    await act(async () => editor.close(undefined, secondId));
    assert.equal(editor.document.id, firstId);
    assert.equal(editor.documents.length, 1);
    await act(async () => editor.open("/other", "first.txt"));
    assert.equal(editor.documents.length, 2);
    assert.notEqual(editor.document.id, firstId);
    await act(async () => editor.closeDirectory("/other"));
    assert.equal(editor.documents.length, 1);
    await act(async () => editor.open("/repo", "first.txt"));
    const firstTab = tabs().find((item) => item.id === `workspace-file-${firstId}`);
    await act(async () =>
      firstTab.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Home",
          bubbles: true,
        }),
      ),
    );
    assert.equal(editor.document, null);
    await act(async () => setUiLanguage("zh-Hans"));
    assert.equal(
      document.querySelector('[role="tablist"]').getAttribute("aria-label"),
      "工作区标签",
    );
    assert.match(
      document.querySelector(".workspace-tab-close").getAttribute("aria-label"),
      /关闭文件/,
    );
    limit = 2;
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => editor.open("/repo", "second.txt"));
    await act(async () => editor.open("/repo", "first.txt"));
    await act(async () => editor.open("/repo", "third.txt"));
    assert.deepEqual(
      editor.documents.map((file) => file.path),
      ["second.txt", "third.txt"],
    );
    assert.equal(editor.document.path, "third.txt");
    await act(async () => editor.open("/repo", "second.txt"));
    await act(async () => editor.change("protected draft"));
    failSave = true;
    limit = 1;
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(editor.pending, true);
    assert.equal(editor.documents.length, 2);
    assert.equal(editor.document.text, "protected draft");
    await act(async () => editor.discard());
    assert.equal(editor.documents.length, 1);
    assert.equal(editor.documents[0].path, "third.txt");
    assert.equal(editor.document, null);
    failSave = false;
    await act(async () => editor.open("/repo", "fourth.txt"));
    assert.equal(editor.documents.length, 1);
    assert.equal(editor.document.path, "fourth.txt");
    assert.ok(tabs().some((tab) => tab.textContent === "Terminal"));
    assert.equal(calls.filter((call) => call.command === "control_session").length, 0);
    await act(async () =>
      root.render(
        React.createElement(WorkspaceTabs, {
          sessions: [],
          documents: editor.documents,
          activeFile: null,
          activeSession: null,
          detectedAgents: {},
          disabled: false,
          selectSession() {},
          selectFile() {},
          closeFile() {},
        }),
      ),
    );
    assert.equal(document.querySelector('[role="tab"]').tabIndex, 0);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
