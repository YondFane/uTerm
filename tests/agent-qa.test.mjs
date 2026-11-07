import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";
import React from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("real Agent components complete QA actions and explicitly recover one busy save before observation", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLDialogElement",
    "Event",
    "Node",
    "localStorage",
  ])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const click = dom.window.HTMLElement.prototype.click;
  dom.window.HTMLElement.prototype.click = function () {
    flushSync(() => click.call(this));
  };
  const dispatch = dom.window.HTMLInputElement.prototype.dispatchEvent;
  dom.window.HTMLInputElement.prototype.dispatchEvent = function (event) {
    let result;
    flushSync(() => {
      result = dispatch.call(this, event);
    });
    return result;
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const root = createRoot(document.getElementById("root"));
  let definitions = [],
    exited = false;
  const calls = [];
  mockIPC((command, args) => {
    calls.push(command);
    if (command === "agent_definitions") return structuredClone(definitions);
    if (command === "save_agents") {
      definitions = structuredClone(args.definitions);
      return null;
    }
    if (command === "agent_hooks") return args.enabled ? "Hooks installed." : "Hooks removed.";
    if (command === "agent_usage") {
      assert.equal(args.remote, false);
      assert.equal(args.allowKeychain, false);
      return { records: 1 };
    }
    if (command === "qa_request_exit") {
      exited = true;
      return null;
    }
    throw Error(`Unexpected native command: ${command}`);
  });
  const setItem = dom.window.Storage.prototype.setItem;
  try {
    const { AgentPanel } = await server.ssrLoadModule("/src/components/AgentPanel.tsx");
    const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
    const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
    const { runAgents } = await server.ssrLoadModule("/src/qa/agents.ts");
    localStorage.setItem(
      settingsKey,
      JSON.stringify({ ...defaults, language: "en", agentNotifications: true }),
    );
    let failedOnce = false;
    dom.window.Storage.prototype.setItem = function (key, value) {
      if (
        key === settingsKey &&
        JSON.parse(value).enabledAgents.includes("qa-core-agent") &&
        !failedOnce
      ) {
        failedOnce = true;
        throw Error("Another writer owns the canonical store");
      }
      return setItem.call(this, key, value);
    };
    function Harness() {
      const [open, setOpen] = React.useState(false);
      const [runtime, setRuntime] = React.useState({
        platform: "windows",
        agents: [],
        agent_definitions: [],
        debug: true,
      });
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          { "aria-label": "Agent", onClick: () => setOpen(true) },
          "Agent",
        ),
        open &&
          React.createElement(AgentPanel, {
            runtime,
            close: () => setOpen(false),
            reload: async () => {
              setRuntime({
                ...runtime,
                agents: definitions.map((item) => item.id),
                agent_definitions: structuredClone(definitions),
              });
            },
          }),
      );
    }
    flushSync(() =>
      root.render(React.createElement(SettingsProvider, null, React.createElement(Harness))),
    );
    const scenes = [];
    await runAgents(
      async (name, checks) => scenes.push({ name, checks }),
      async () => {
        assert.equal(document.querySelector(".notification-toggle input")?.disabled, false);
        const enabled = document.querySelector('[aria-label="Enable Shared Agent QA"]');
        if (enabled) assert.equal(enabled.disabled, false, "Observer ran during the tested save");
        return { document: { settings: JSON.parse(localStorage.getItem(settingsKey)) } };
      },
    );
    assert.deepEqual(
      scenes.map((scene) => scene.name),
      ["agent-live-command", "agent-live-hooks", "agent-live-errors"],
    );
    assert.equal(scenes[0].checks.writerBusyRetries, 1);
    assert.equal(scenes[0].checks.settingWritesCompletedBeforeObserverRead, true);
    assert.equal(failedOnce, true);
    assert.equal(exited, true);
    assert.deepEqual(definitions, []);
    assert.deepEqual(JSON.parse(localStorage.getItem(settingsKey)).enabledAgents, []);
    assert.equal(
      calls.some((command) => command.startsWith("plugin:notification")),
      false,
    );
  } finally {
    dom.window.Storage.prototype.setItem = setItem;
    flushSync(() => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
