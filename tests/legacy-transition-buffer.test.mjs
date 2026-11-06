import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { JSDOM } from "jsdom";
import React, { act, useRef } from "react";
import { renderedText, terminalInputReady } from "../scripts/fixtures/legacy-transition-buffer.ts";
import { readSettings, defaults, settingsKey } from "../src/lib/settings.ts";
import { readWorkspace, workspaceKey } from "../src/lib/workspace.ts";
import { readDraft, draftKey } from "../src/lib/file-document.ts";

const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Text"])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");

test("historical QA reads a real React xterm ref when canvas output has no DOM text", async () => {
  const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 3, disableStdin: true });
  const marker = "LEGACY_BEFORE_0123456789abcdef0123456789abcdef";
  await new Promise((done) => terminal.write(marker, done));
  function HistoricalView() {
    useRef(terminal);
    return React.createElement("section", { id: "historical" });
  }
  const root = createRoot(document.getElementById("root"));
  try {
    await act(() => root.render(React.createElement(HistoricalView)));
    const section = document.getElementById("historical");
    assert.equal(section.textContent, "");
    assert.equal(renderedText(section).replace(/\s/g, ""), marker);
    assert.equal(renderedText(document.createElement("section")), "");
    assert.equal(terminalInputReady(section), false);
    terminal.options.disableStdin = false;
    assert.equal(terminalInputReady(section), true);
    assert(!renderedText(section).includes("LEGACY_ROLLBACK_"));
  } finally {
    await act(() => root.unmount());
    terminal.dispose();
    dom.window.close();
  }
});

test("recovery QA observes the real xterm and draft without triggering navigation autosave", async () => {
  const source = readFileSync(
    new URL("../scripts/fixtures/legacy-transition.ts", import.meta.url),
    "utf8",
  );
  const edits = [];
  for (const entry of parse(source, { sourceType: "module", plugins: ["typescript"] }).program
    .body) {
    if (entry.type === "ImportDeclaration") {
      const names = entry.specifiers.map((item) => {
        assert.equal(item.type, "ImportSpecifier");
        return item.imported.name + ":" + item.local.name;
      });
      edits.push([
        entry.start,
        entry.end,
        `const {${names}} = modules[${JSON.stringify(entry.source.value)}];`,
      ]);
    } else if (entry.type === "ExportNamedDeclaration") {
      edits.push([entry.start, entry.declaration.start, ""]);
    }
  }
  let executable = source;
  for (const [start, end, text] of edits.reverse())
    executable = executable.slice(0, start) + text + executable.slice(end);
  const compiled =
    stripTypeScriptTypes(executable) + "\nreturn {seedLegacyTransition, runLegacyTransition};";
  for (const phase of ["before", "rollback"]) {
    const page = new JSDOM('<div id="root"></div>', { url: "https://qa.invalid" });
    for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Text"])
      Object.defineProperty(globalThis, key, { configurable: true, value: page.window[key] });
    const storage = page.window.localStorage;
    const checkpoint = phase === "before" ? "LEGACY_BEFORE_" + "a".repeat(32) : "TRANSITION_REOPEN";
    const draft = {
      kind: "text",
      directory: "/tmp/project",
      path: "upgrade.txt",
      text: "UNSAVED 中文 é\r\n",
      saved: "ORIGINAL\r\n",
      version: "a".repeat(64),
      bom: true,
      line_ending: "\r\n",
    };
    const workspace = {
      ...readWorkspace(null),
      selectedProject: "project",
      selectedSession: "session",
      projects: [
        {
          id: "project",
          name: "QA",
          directory: "/tmp/project",
          workspaceId: "local",
          sessions: [{ id: "session", name: "Terminal", shell: "default" }],
        },
      ],
    };
    const context = {
      phase,
      project: "/tmp/project",
      projectID: "project",
      fileName: "upgrade.txt",
      draftText: draft.text,
      markerSuffix: "a".repeat(32),
      replayMarker: checkpoint,
      seed: {},
      expected: { id: "session", generation: "generation", hostPID: 123, fontSize: 18 },
    };
    storage.setItem(workspaceKey, JSON.stringify(workspace));
    storage.setItem(settingsKey, JSON.stringify({ ...defaults, fontSize: 18 }));
    storage.setItem(draftKey, JSON.stringify(draft));
    storage.setItem("qa.transition.seeded-phase", phase);
    let diskText = draft.saved;
    let navigations = 0;
    function HistoricalView() {
      useRef(terminal);
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "div",
          { className: "folder-row", "data-project-id": "project" },
          React.createElement(
            "button",
            {
              className: "row-label",
              onClick() {
                navigations++;
                diskText = draft.text;
              },
            },
            "QA",
          ),
        ),
        React.createElement("section", {
          className: "local-session visible",
          "data-session-id": "session",
        }),
        React.createElement(
          "div",
          { className: "cm-content", contentEditable: true, suppressContentEditableWarning: true },
          draft.text.trim(),
        ),
      );
    }
    const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 3 });
    await new Promise((done) => terminal.write(checkpoint, done));
    const root = createRoot(document.getElementById("root"));
    let resolveExport;
    const exported = new Promise((resolve) => {
      resolveExport = resolve;
    });
    const invoke = async (command, args) => {
      if (command === "qa_legacy_context") return context;
      if (command === "qa_legacy_host")
        return { pid: 123, sessions: [{ spec: { id: "session" }, generation: "generation" }] };
      if (command === "qa_legacy_export") {
        resolveExport(args);
        return;
      }
      if (command === "qa_legacy_capture_ack") return new Promise(() => {});
      throw Error("Unexpected recovery mutation: " + command);
    };
    const modules = {
      "./qa-legacy-transition-buffer": { renderedText, terminalInputReady },
      "@tauri-apps/api/core": { invoke },
      "./lib/settings": { readSettings, settingsKey },
      "./lib/workspace": { readWorkspace, workspaceKey },
      "./lib/file-document": { readDraft, draftKey },
    };
    let timer;
    try {
      await act(() => root.render(React.createElement(HistoricalView)));
      const qa = new Function("modules", "document", "localStorage", compiled)(
        modules,
        document,
        storage,
      );
      await qa.seedLegacyTransition();
      void qa.runLegacyTransition().catch(() => {});
      const result = await Promise.race([
        exported,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Recovery export timed out")), 2000);
        }),
      ]);
      assert.equal(result.checks.error, undefined);
      assert.equal(result.checks.actualPTYReplayWithRecoveredEditor, true);
      assert.equal(result.checks.actualDOMInputAndPTY, false);
      assert.equal(result.checks.simulatedInitialDraftInput, false);
      assert.equal(result.checks.renderedCheckpoint, checkpoint);
      assert.equal(navigations, 0);
      assert.equal(diskText, draft.saved);
      assert.equal(storage.getItem(draftKey), JSON.stringify(draft));
    } finally {
      clearTimeout(timer);
      await act(() => root.unmount());
      terminal.dispose();
      page.window.close();
    }
  }
});
