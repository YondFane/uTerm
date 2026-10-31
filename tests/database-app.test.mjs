import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("App isolates Database views from inspectors, restores the selected tool and preserves local sessions", async () => {
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
          if (
            id.endsWith("/TerminalWorkspace") ||
            id.endsWith("/DeferredFileEditor") ||
            id.endsWith("/FileEditor")
          )
            return "\0ssh-test:" + id.split("/").at(-1);
        },
        load(id) {
          if (id === "\0ssh-test:TerminalWorkspace")
            return `import React from 'react'; export function TerminalWorkspace(props) { globalThis.databaseAppTerminalProps = props; return React.createElement('div', null); }`;
          if (id === "\0ssh-test:FileEditor")
            return `import React from 'react'; export function CodeEditor({document,change}) { return React.createElement('textarea', {value:document.text,onChange:event=>change(event.target.value)}); }`;
          if (id === "\0ssh-test:DeferredFileEditor")
            return `export function DeferredFileEditor() { return null; }`;
        },
      },
    ],
  });
  const { App } = await server.ssrLoadModule("/src/App.tsx");
  const { SettingsProvider, useSettings } = await server.ssrLoadModule(
    "/src/lib/SettingsContext.tsx",
  );
  const { emptyWorkspace, workspaceKey } = await server.ssrLoadModule("/src/lib/workspace.ts");
  const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
  const state = emptyWorkspace();
  const connection = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Database App QA",
    host: "127.0.0.1",
    port: 6379,
    kind: "mysql",
    database: "",
    username: "",
    tls: true,
    ca_file: "",
    credential_id: null,
  };
  state.version = 6;
  state.projects = [
    {
      id: "project",
      name: "Inspector QA",
      directory: "/local/project",
      workspaceId: state.selectedWorkspace,
      sessions: [],
      worktrees: [],
    },
  ];
  state.selectedProject = "project";
  state.groups[0].databaseConnections = [connection];
  state.groups[0].terminals = [
    { id: "local-session", name: "Local", shell: "default", directory: "/local" },
  ];
  const original = JSON.stringify(state);
  localStorage.setItem(workspaceKey, original);
  localStorage.setItem(
    settingsKey,
    JSON.stringify({ ...defaults, sidebarStyle: "classic", language: "en" }),
  );
  const calls = [];
  mockIPC((command, args) => {
    if (command === "project_run_summary") return { java: 0, python: 0 };
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
    if (command === "project_worktrees" || command === "directory_tools") return [];
    if (command === "git_branches") return { current: "main", local: ["main"], remote: [] };
    if (command === "git_snapshot")
      return { root: args.directory, branch: "main", references: ["main"], changes: [] };
    if (command === "github_repositories") return [];
    if (command === "database_components") return { items: [], java: null, busy: false };
    return null;
  });
  let preferences;
  function Harness() {
    preferences = useSettings();
    return React.createElement(App);
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () =>
      root.render(React.createElement(SettingsProvider, null, React.createElement(Harness))),
    );
    assert.equal(localStorage.getItem(`${workspaceKey}.v6-backup`), original);
    const shell = () => document.querySelector(".app-shell");
    const inspector = () => document.querySelector(".app-shell > :is(.file-panel, .git-panel)");
    const project = () =>
      document.querySelector('.folder-row[data-project-id="project"] > .row-label');
    for (const position of ["left", "right"]) {
      await act(async () =>
        preferences.save({ ...preferences.settings, inspectorPosition: position }),
      );
      for (const tool of ["Files", "Git", "GitHub", "Working directory"]) {
        await act(async () =>
          document.querySelector(`.inspector-switcher button[title="${tool}"]`).click(),
        );
        const panelLabel = inspector().getAttribute("aria-label");
        assert.ok(shell().classList.contains("with-inspector"));
        assert.equal(shell().dataset.inspectorPosition, position);
        const beforeComponents = calls.length;
        await act(async () =>
          document.querySelector('.sidebar-section button[title="Database components"]').click(),
        );
        assert.ok(document.querySelector(".database-component-workspace"));
        assert.equal(shell().classList.contains("with-inspector"), false);
        assert.ok(!inspector(), `${tool} must hide with its grid column (${position})`);
        assert.ok(document.querySelector(".sidebar-rail-footer"));
        assert.equal(
          calls
            .slice(beforeComponents)
            .some((call) =>
              ["git_snapshot", "github_repositories", "files_list", "directory_tools"].includes(
                call.command,
              ),
            ),
          false,
        );
        await act(async () => project().click());
        assert.equal(document.querySelector(".database-component-workspace"), null);
        assert.ok(shell().classList.contains("with-inspector"));
        assert.equal(inspector().getAttribute("aria-label"), panelLabel);
      }
    }
    const profile = [...document.querySelectorAll("button")].find(
      (button) =>
        button.className === "row-label" && button.textContent.endsWith("Database App QA"),
    );
    const before = calls.length;
    await act(async () => profile.click());
    assert.equal(document.querySelectorAll("main").length, 1);
    assert.equal(document.querySelector("main > header h1").textContent, "Database App QA");
    assert.equal(document.querySelector('section[aria-label="Database workbench"]').hidden, false);
    assert.equal(shell().classList.contains("with-inspector"), false);
    assert.ok(!inspector());
    assert.equal(document.querySelector('select[aria-label="New session shell"]'), null);
    assert.equal(
      calls
        .slice(before)
        .some((call) =>
          [
            "database_connect",
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
    assert.deepEqual(saved.groups[0].databaseConnections, [connection]);
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
    assert.equal(globalThis.databaseAppTerminalProps.closeRequest, null);
    assert.equal(JSON.parse(localStorage.getItem(workspaceKey)).groups[0].terminals.length, 1);
    assert.equal(document.querySelector('section[aria-label="Database workbench"]').hidden, true);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.isTauri;
    delete globalThis.databaseAppTerminalProps;
  }
});
