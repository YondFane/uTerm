import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("run panels follow project selection, preserve failed drafts and navigate live tasks across workspaces and Worktrees", async () => {
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
    server: { middlewareMode: true, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    plugins: [
      {
        name: "project-run-renderers",
        enforce: "pre",
        resolveId(id) {
          if (
            [
              "/JavaBuildPanel",
              "/PythonRunPanel",
              "/TerminalWorkspace",
              "/DeferredFileEditor",
              "/FileEditor",
            ].some((name) => id.endsWith(name))
          )
            return "\0project-run:" + id.split("/").at(-1);
        },
        load(id) {
          if (id.endsWith(":JavaBuildPanel") || id.endsWith(":PythonRunPanel")) {
            const name = id.split(":").at(-1);
            const language = name === "JavaBuildPanel" ? "java" : "python";
            return `import React from "react"; export function ${name}(props) {
            React.useEffect(() => { props.registerClose(() => globalThis.prepareProjectRun(${JSON.stringify(language)}, props.directory)); return () => props.registerClose(null); }, [props.directory, props.registerClose]);
            return React.createElement("section", {"data-run-panel":${JSON.stringify(language)}, "data-directory":props.directory, hidden:!props.visible});
          }`;
          }
          if (id.endsWith(":TerminalWorkspace"))
            return "export function TerminalWorkspace() { return null; }";
          if (id.endsWith(":DeferredFileEditor"))
            return "export function DeferredFileEditor() { return null; }";
          if (id.endsWith(":FileEditor")) return "export function CodeEditor() { return null; }";
        },
      },
    ],
  });
  const { App } = await server.ssrLoadModule("/src/App.tsx");
  const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
  const { emptyWorkspace, workspaceKey, createWorkspaceGroup } =
    await server.ssrLoadModule("/src/lib/workspace.ts");
  const { findRunProject } = await server.ssrLoadModule("/src/lib/useProjectRunSummary.ts");
  const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
  const state = emptyWorkspace();
  state.groups.push(createWorkspaceGroup("other", "Other workspace"));
  const tree = {
    id: "tree",
    path: "/one/tree",
    branch: "feature/tree",
    name: "Tree",
    missing: false,
  };
  state.projects = [
    {
      id: "one",
      name: "One",
      directory: "/one",
      workspaceId: "local",
      sessions: [],
      worktrees: [tree],
    },
    { id: "two", name: "Two", directory: "/two", workspaceId: "local", sessions: [] },
    { id: "third", name: "Third", directory: "/third", workspaceId: "other", sessions: [] },
  ];
  state.selectedProject = "one";
  state.selectedSession = null;
  localStorage.setItem(workspaceKey, JSON.stringify(state));
  localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
  const task = (id, root, action, running = true, created = 0) => ({
    spec: { id },
    generation: id,
    task: { root, action, name: id, created },
    running,
    code: null,
  });
  const tasks = [
    task("Java third", "/third", "run", true, 2),
    task("Java one", "/one", "run"),
    task("Python tree", "/one/tree", "python:run|http://127.0.0.1:8000"),
    task("Old run", "/two", "run", false),
    task("Build", "/two", "build"),
  ];
  const saves = [];
  let prepare = async () => true;
  globalThis.prepareProjectRun = (language, directory) => {
    saves.push({ language, directory });
    return prepare();
  };
  let listFailure = false;
  let summaryFailure = false;
  let runSummary = {
    java: 2,
    python: 1,
    java_roots: ["/one", "/third"],
    python_roots: ["/one/tree"],
  };
  let listPending;
  let listValues = tasks;
  mockIPC((command, args) => {
    if (command === "project_run_summary") {
      if (summaryFailure) throw new Error("Host unavailable");
      return runSummary;
    }
    if (command === "project_run_list") {
      if (listFailure) throw new Error("Host unavailable");
      return listPending ?? listValues;
    }
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
    if (command === "project_worktrees") return args.directory === "/one" ? [tree] : [];
    if (command === "files_list") return { entries: [], partial: false, skipped: 0 };
    if (command === "git_branches") return { current: "main", local: ["main"] };
    if (command === "update_status") return { enabled: false, version: "", downloaded: false };
    return null;
  });
  const root = createRoot(document.getElementById("root"));
  const button = (language) =>
    document.querySelector(`.toolbar-actions .toolbar-icon-${language}`).closest("button");
  const panel = () => document.querySelector("[data-run-panel]:not([hidden])");
  const settlePanel = async () => {
    for (let attempt = 0; attempt < 50 && !panel(); attempt++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.ok(panel(), "run panel finished loading");
  };
  const stored = () => JSON.parse(localStorage.getItem(workspaceKey));
  const resource = (name) =>
    [...document.querySelectorAll(".sidebar .folder-row .row-label")]
      .find((item) => item.title.startsWith(`${name} — `))
      .querySelector(".sidebar-resource-icon");
  const refreshRuns = () => act(async () => window.dispatchEvent(new dom.window.Event("focus")));
  const clickProject = (name) =>
    act(async () =>
      [...document.querySelectorAll("button[title]")]
        .find((item) => item.title.startsWith(`${name} — `))
        .click(),
    );
  const openList = (language) =>
    act(async () =>
      button(language).dispatchEvent(
        new dom.window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 1000,
          clientY: 700,
        }),
      ),
    );
  const key = (target, value) =>
    act(async () =>
      target.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
      ),
    );
  try {
    await act(async () =>
      root.render(React.createElement(SettingsProvider, null, React.createElement(App))),
    );
    assert.ok(resource("One").querySelector(".toolbar-icon-java.toolbar-icon-running"));
    assert.ok(resource("Tree").querySelector(".toolbar-icon-python.toolbar-icon-running"));
    assert.equal(resource("Two").querySelector(".toolbar-icon-running"), null);
    await act(async () => button("java").click());
    await settlePanel();
    assert.equal(panel().dataset.directory, "/one");
    let finishSave;
    prepare = () =>
      new Promise((resolve) => {
        finishSave = resolve;
      });
    await clickProject("Two");
    assert.equal(panel(), null);
    assert.equal(document.querySelector("[data-run-panel]").dataset.directory, "/one");
    assert.match(document.body.textContent, /Switching run projects/);
    await act(async () => finishSave(true));
    assert.equal(panel().dataset.directory, "/two");
    assert.deepEqual(saves.at(-1), { language: "java", directory: "/one" });
    prepare = async () => false;
    await clickProject("One");
    assert.equal(stored().selectedProject, "two");
    assert.equal(panel().dataset.directory, "/two");
    assert.match(document.body.textContent, /Cannot switch run projects/);
    prepare = async () => true;
    await clickProject("One");
    await act(async () => button("python").click());
    await settlePanel();
    assert.equal(panel().dataset.runPanel, "python");
    await clickProject("Two");
    assert.equal(panel().dataset.directory, "/two");
    assert.deepEqual(saves.at(-1), { language: "python", directory: "/one" });

    prepare = () =>
      new Promise((resolve) => {
        finishSave = resolve;
      });
    await clickProject("One");
    assert.equal(panel(), null);
    await clickProject("Two");
    await act(async () => finishSave(true));
    assert.equal(panel().dataset.directory, "/two");
    prepare = async () => false;
    await clickProject("One");
    assert.equal(stored().selectedProject, "two");
    assert.equal(panel().dataset.directory, "/two");
    prepare = async () => true;

    await openList("java");
    assert.deepEqual(
      [...document.querySelectorAll('.project-run-menu [role="menuitem"]')].map(
        (item) => item.textContent,
      ),
      ["Java third/third", "Java one/one"],
    );
    await key(document.querySelector(".project-run-menu"), "ArrowUp");
    assert.match(document.activeElement.textContent, /Java one/);
    await key(document.activeElement, "Escape");
    assert.equal(document.querySelector(".project-run-menu"), null);
    assert.equal(document.activeElement, button("java"));
    await openList("java");
    await act(async () => document.querySelector('.project-run-menu [role="menuitem"]').click());
    assert.equal(stored().selectedWorkspace, "other");
    assert.equal(stored().selectedProject, "third");
    assert.ok(resource("Third").querySelector(".toolbar-icon-java.toolbar-icon-running"));
    assert.equal(panel().dataset.directory, "/third");
    assert.equal(panel().dataset.runPanel, "java");
    await openList("python");
    assert.equal(document.querySelectorAll('.project-run-menu [role="menuitem"]').length, 1);
    await act(async () => document.querySelector('.project-run-menu [role="menuitem"]').click());
    assert.equal(stored().selectedWorkspace, "local");
    assert.equal(stored().selectedWorktree, "tree");
    assert.equal(panel().dataset.directory, "/one/tree");
    assert.equal(panel().dataset.runPanel, "python");

    listFailure = true;
    await openList("java");
    assert.match(
      document.querySelector('.project-run-menu [role="alert"]').textContent,
      /Could not read running projects/,
    );
    await act(async () =>
      document.body.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })),
    );
    assert.equal(document.querySelector(".project-run-menu"), null);
    listFailure = false;
    listValues = [];
    await openList("java");
    assert.match(
      document.querySelector('.project-run-menu [role="status"]').textContent,
      /No running projects/,
    );
    await key(document.querySelector(".project-run-menu"), "Escape");
    listValues = tasks;
    let finishList;
    listPending = new Promise((resolve) => {
      finishList = resolve;
    });
    await openList("python");
    await key(document.querySelector(".project-run-menu"), "Escape");
    await act(async () => finishList(tasks));
    assert.equal(document.querySelector(".project-run-menu"), null);

    runSummary = { ...runSummary, java_roots: ["/third", "/two"] };
    await refreshRuns();
    assert.equal(resource("One").querySelector(".toolbar-icon-running"), null);
    assert.ok(resource("Two").querySelector(".toolbar-icon-java.toolbar-icon-running"));
    assert.ok(resource("Tree").querySelector(".toolbar-icon-python.toolbar-icon-running"));
    summaryFailure = true;
    await refreshRuns();
    assert.ok(resource("Two").querySelector(".toolbar-icon-java.toolbar-icon-running"));
    assert.match(resource("Two").title, /temporarily unavailable/);
    summaryFailure = false;
    runSummary = { java: 1, python: 0, java_roots: ["/third"], python_roots: [] };
    await refreshRuns();
    assert.equal(resource("Two").querySelector(".toolbar-icon-running"), null);
    assert.equal(resource("Tree").querySelector(".toolbar-icon-running"), null);

    const windows = {
      ...state,
      projects: [
        {
          ...state.projects[0],
          directory: "C:\\Repo",
          worktrees: [{ ...tree, path: "C:\\Repo tree" }],
        },
      ],
    };
    assert.equal(findRunProject(windows, String.raw`\\?\c:\repo` + "\\").project.id, "one");
    assert.equal(findRunProject(windows, "c:/repo tree/").worktree.id, "tree");
    assert.equal(findRunProject(state, "/ONE"), null);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.prepareProjectRun;
  }
});
