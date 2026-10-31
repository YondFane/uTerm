import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createServer } from "vite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Python panel protects drafts and pending runs, preserves history, and exposes force stop after errors", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    plugins: [
      {
        name: "python-terminal-probe",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/TerminalView")) return "\0python-terminal";
        },
        load(id) {
          if (id === "\0python-terminal")
            return 'import React from "react"; export function TerminalView(props) { globalThis.pythonTerminal = props; return React.createElement("div", {"data-log-view":props.logView}); }';
        },
      },
    ],
  });
  const { PythonRunPanel } = await server.ssrLoadModule("/src/components/PythonRunPanel.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const project = {
    interpreter: "D:\\.venv\\Scripts\\python.exe",
    mode: "fastapi",
    target: "app.main:app",
    working_directory: ".",
    arguments: [],
    host: "127.0.0.1",
    port: 8000,
    reload: false,
  };
  let config = { revision: "r1", configured: true, project };
  const task = {
    spec: { id: "python-task", directory: "/project", shell: "default", agent: null },
    generation: "generation-1",
    task: {
      root: "/project",
      name: "app.main:app",
      action: "python:run|http://127.0.0.1:8000",
      created: 1,
    },
    running: true,
    code: null,
  };
  const writes = [],
    starts = [],
    stops = [];
  let tasks = [],
    prepare,
    resolveStart,
    hold = false,
    conflict = false;
  mockIPC((command, args) => {
    if (command === "python_configuration") return structuredClone(config);
    if (command === "python_detect_interpreters")
      return [{ path: project.interpreter, version: "3.13", virtual_environment: true }];
    if (command === "python_project")
      return {
        candidates: [{ mode: "fastapi", target: "app.main:app", working_directory: "." }],
        truncated: false,
      };
    if (command === "python_tasks") return structuredClone(tasks);
    if (command === "python_save_configuration") {
      writes.push(args);
      if (conflict || args.revision !== config.revision) throw new Error("PYTHON_CONFIG_CONFLICT");
      config = {
        revision: `r${writes.length + 1}`,
        configured: true,
        project: structuredClone(args.config),
      };
      return structuredClone(config);
    }
    if (command === "python_start") {
      starts.push(args);
      if (hold)
        return new Promise((resolve) => {
          resolveStart = () => {
            tasks = [task];
            resolve(task);
          };
        });
      tasks = [task];
      return task;
    }
    if (command === "python_stop") {
      stops.push(args);
      if (!args.force) throw new Error("STOP_DENIED");
      tasks = [{ ...task, running: false, code: 1 }];
      return;
    }
    if (command === "python_select_path") return null;
    if (command === "open_external") return;
    throw new Error(command);
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  let closed = 0;
  const props = {
    directory: "/project",
    close: () => {
      closed++;
    },
    registerClose: (value) => {
      prepare = value;
    },
  };
  const render = (visible = true) =>
    act(async () => {
      root.render(React.createElement(PythonRunPanel, { ...props, visible }));
    });
  const button = (text) =>
    [...document.querySelectorAll("button")].find(
      (element) => element.textContent === text || element.getAttribute("aria-label") === text,
    );
  const click = (text) =>
    act(async () => {
      const element = button(text);
      assert.ok(element, text);
      element.click();
    });
  const input = async (selector, value) =>
    act(async () => {
      const element = document.querySelector(selector);
      const prototype =
        element.tagName === "TEXTAREA"
          ? dom.window.HTMLTextAreaElement.prototype
          : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  try {
    await render();
    assert.ok(button("Run"));
    await input('input[aria-label="Application entry"]', "custom.main:app");
    await input("textarea", '"literal & %PATH% 中文"');
    await input("textarea[placeholder]", "VALUE=temporary-secret");
    await click("Check again");
    assert.equal(
      document.querySelector('input[aria-label="Application entry"]').value,
      "custom.main:app",
    );
    await render(false);
    assert.equal(document.querySelector(".python-run-panel").hidden, true);
    await render(true);
    conflict = true;
    await act(async () => {
      assert.equal(await prepare(), false);
    });
    assert.match(document.querySelector('[role="alert"]').textContent, /another window/i);
    assert.equal(
      document.querySelector('input[aria-label="Application entry"]').value,
      "custom.main:app",
    );
    conflict = false;
    hold = true;
    await click("Run");
    assert.equal(await prepare(), false);
    assert.equal(button("Hide run panel").disabled, true);
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].config.arguments, ["literal & %PATH% 中文"]);
    assert.deepEqual({ ...starts[0].environment }, { VALUE: "temporary-secret" });
    assert.equal(JSON.stringify(writes).includes("temporary-secret"), false);
    await act(async () => resolveStart());
    assert.equal(globalThis.pythonTerminal.logView, true);
    assert.match(document.querySelector('[role="status"]').textContent, /Process running/);
    await click("Stop");
    assert.match(document.querySelector('[role="alert"]').textContent, /STOP_DENIED/);
    assert.ok(button("Force stop"));
    await click("Force stop");
    assert.equal(stops.at(-1).generation, "generation-1");
    assert.equal(stops.at(-1).force, true);
    assert.ok(globalThis.pythonTerminal);
    await click("Hide run panel");
    assert.equal(closed, 1);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.pythonTerminal;
  }
});
