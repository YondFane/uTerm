import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Git Worktree registration refreshes the owning project, preserves its selection and reports storage failures", async () => {
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
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    plugins: [
      {
        name: "git-worktree-renderers",
        enforce: "pre",
        resolveId(id) {
          if (
            ["/GitPanel", "/TerminalWorkspace", "/DeferredFileEditor", "/FileEditor"].some((name) =>
              id.endsWith(name),
            )
          )
            return "\0git-worktree:" + id.split("/").at(-1);
        },
        load(id) {
          if (id === "\0git-worktree:GitPanel")
            return `export function GitPanel(props) { globalThis.gitWorktreeAppProps = props; return null; }`;
          if (id === "\0git-worktree:TerminalWorkspace")
            return `export function TerminalWorkspace() { return null; }`;
          if (id === "\0git-worktree:DeferredFileEditor")
            return `export function DeferredFileEditor() { return null; }`;
          if (id === "\0git-worktree:FileEditor")
            return `export function CodeEditor() { return null; }`;
        },
      },
    ],
  });
  const { App } = await server.ssrLoadModule("/src/App.tsx");
  const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
  const { emptyWorkspace, workspaceKey } = await server.ssrLoadModule("/src/lib/workspace.ts");
  const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
  const state = emptyWorkspace();
  const existing = {
    id: "existing-tree",
    path: "/repo/tree",
    branch: "feature/existing",
    name: "Keep this name",
    missing: false,
  };
  const session = {
    id: "session",
    name: "Keep session",
    shell: "default",
    pinned: false,
    worktreeId: existing.id,
  };
  state.projects = [
    {
      id: "project",
      name: "Repository",
      directory: "/repo",
      workspaceId: state.selectedWorkspace,
      sessions: [session],
      worktrees: [existing],
    },
  ];
  state.selectedProject = "project";
  state.selectedWorktree = existing.id;
  state.selectedSession = session.id;
  localStorage.setItem(workspaceKey, JSON.stringify(state));
  localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
  let created = false;
  const calls = [];
  mockIPC((command, args) => {
    if (command === "project_run_summary") return { java: 0, python: 0 };
    calls.push({ command, args });
    if (command === "runtime_info")
      return {
        platform: "windows",
        home: "/home",
        agents: [],
        agent_definitions: [],
        version: "test",
        debug: true,
        chat_directory: "/home/chats",
      };
    if (command === "local_session_list" || command === "ssh_session_list")
      return { sessions: [], closed: [] };
    if (command === "project_worktrees")
      return [
        existing,
        ...(created ? [{ path: "/repo/new-tree", branch: "feature/new", missing: false }] : []),
      ];
    if (command === "files_list") return { entries: [], partial: false, skipped: 0 };
    if (command === "git_branches")
      return { current: "feature/existing", local: ["feature/existing"] };
    if (command === "update_status") return { enabled: false, version: "", downloaded: false };
    return null;
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () =>
      root.render(React.createElement(SettingsProvider, null, React.createElement(App))),
    );
    await act(async () =>
      document.querySelector('.inspector-switcher button[title="Git"]').click(),
    );
    assert.equal(globalThis.gitWorktreeAppProps.directory, "/repo/tree");
    created = true;
    await act(async () => globalThis.gitWorktreeAppProps.onWorktreeCreated("/repo/tree"));
    assert.equal(
      calls.filter((call) => call.command === "project_worktrees").at(-1).args.directory,
      "/repo",
    );
    const saved = JSON.parse(localStorage.getItem(workspaceKey));
    assert.equal(saved.selectedProject, "project");
    assert.equal(saved.selectedWorktree, existing.id);
    assert.equal(saved.selectedSession, session.id);
    assert.equal(saved.projects[0].worktrees.length, 2);
    assert.equal(saved.projects[0].worktrees[0].name, existing.name);
    assert.deepEqual(saved.projects[0].sessions, [session]);
    assert.equal(
      calls.some((call) => call.command === "start_session"),
      false,
    );
    const stored = localStorage.getItem(workspaceKey);
    const setItem = dom.window.Storage.prototype.setItem;
    dom.window.Storage.prototype.setItem = function (key, value) {
      if (key === workspaceKey) throw new Error("Storage full");
      return setItem.call(this, key, value);
    };
    await act(async () =>
      assert.rejects(
        globalThis.gitWorktreeAppProps.onWorktreeCreated("/repo/tree"),
        /project tree could not be saved/,
      ),
    );
    assert.equal(localStorage.getItem(workspaceKey), stored);
    dom.window.Storage.prototype.setItem = setItem;
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.gitWorktreeAppProps;
  }
});
