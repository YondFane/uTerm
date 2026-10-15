import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("App migrates Redis profiles, isolates the workbench and never closes a local session from its view", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLDialogElement",
    "Node",
    "localStorage",
  ])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.isTauri = true;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    plugins: [
      {
        name: "ssh-test-renderers",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/TerminalWorkspace") || id.endsWith("/DeferredFileEditor"))
            return "\0ssh-test:" + id.split("/").at(-1);
        },
        load(id) {
          if (id === "\0ssh-test:TerminalWorkspace")
            return `import React from 'react'; export function TerminalWorkspace(props) { globalThis.redisAppTerminalProps = props; return React.createElement('div', null); }`;
          if (id === "\0ssh-test:DeferredFileEditor")
            return `export function DeferredFileEditor() { return null; }`;
        },
      },
    ],
  });
  const { App } = await server.ssrLoadModule("/src/App.tsx");
  const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
  const { emptyWorkspace, workspaceKey } = await server.ssrLoadModule("/src/lib/workspace.ts");
  const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
  const state = emptyWorkspace();
  const connection = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Redis App QA",
    host: "127.0.0.1",
    port: 6379,
    db: 0,
    username: "",
    tls: true,
    ca_file: "",
    server_name: "redis.test",
    ssh_host: "",
    credential_id: null,
  };
  state.version = 4;
  state.groups[0].redisConnections = [connection];
  state.groups[0].terminals = [
    { id: "local-session", name: "Local", shell: "default", directory: "/local" },
  ];
  const original = JSON.stringify(state);
  localStorage.setItem(workspaceKey, original);
  localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
  const calls = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "runtime_info")
      return {
        platform: "windows",
        home: "/local",
        agents: [],
        agent_definitions: [],
        version: "test",
        debug: true,
        chat_directory: "/local/chats",
      };
    if (["local_session_list", "ssh_session_list"].includes(command))
      return { sessions: [], closed: [] };

    if (["ssh_files_list", "files_list"].includes(command))
      return { entries: [], partial: false, skipped: 0 };
    if (command === "update_status") return { enabled: false, version: "", downloaded: false };
    return null;
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () =>
      root.render(React.createElement(SettingsProvider, null, React.createElement(App))),
    );
    assert.equal(localStorage.getItem(`${workspaceKey}.v4-backup`), original);
    const profile = [...document.querySelectorAll("button")].find(
      (button) => button.className === "row-label" && button.textContent.endsWith("Redis App QA"),
    );
    const before = calls.length;
    await act(async () => profile.click());
    assert.equal(document.querySelectorAll("main").length, 1);
    assert.equal(document.querySelector("main > header h1").textContent, "Redis App QA");
    assert.equal(document.querySelector('section[aria-label="Redis workbench"]').hidden, false);
    assert.equal(document.querySelector('select[aria-label="New session shell"]'), null);
    assert.equal(
      calls
        .slice(before)
        .some((call) =>
          [
            "redis_connect",
            "git_branches",
            "git_snapshot",
            "files_list",
            "directory_tools",
          ].includes(call.command),
        ),
      false,
    );
    const saved = JSON.parse(localStorage.getItem(workspaceKey));
    assert.equal(saved.version, 7);
    assert.deepEqual(saved.groups[0].redisConnections, [connection]);
    await act(async () =>
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "w",
          code: "KeyW",
          ctrlKey: true,
          bubbles: true,
        }),
      ),
    );
    assert.equal(globalThis.redisAppTerminalProps.closeRequest, null);
    assert.equal(JSON.parse(localStorage.getItem(workspaceKey)).groups[0].terminals.length, 1);
    assert.equal(document.querySelector('section[aria-label="Redis workbench"]').hidden, true);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.isTauri;
    delete globalThis.redisAppTerminalProps;
  }
});
