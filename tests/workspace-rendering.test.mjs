import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

async function setup(t) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.HTMLElement.prototype.setPointerCapture = function () {};
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
  globalThis.workspaceTerminalProps = new Map();
  globalThis.workspaceTerminalMounts = new Map();
  const server = await createServer({
    configFile: false,
    plugins: [
      {
        name: "workspace-terminal-probe",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/TerminalView")) return "\0workspace-terminal";
        },
        load(id) {
          if (id !== "\0workspace-terminal") return;
          return `
          import React, { useEffect } from 'react';
          export function TerminalView(props) {
            globalThis.workspaceTerminalProps.set(props.session.id, props);
            useEffect(() => {
              const mounts = globalThis.workspaceTerminalMounts;
              mounts.set(props.session.id, (mounts.get(props.session.id) ?? 0) + 1);
            }, []);
            return React.createElement('section', { 'data-session-id': props.session.id });
          }`;
        },
      },
    ],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
    delete globalThis.workspaceTerminalProps;
    delete globalThis.workspaceTerminalMounts;
  });
  return { dom, root, load: (path) => server.ssrLoadModule("/src/" + path) };
}

test("terminal derivations survive activity and split previews while immutable edits refresh them", async (t) => {
  const { dom, root, load } = await setup(t);
  const { TerminalWorkspace } = await load("components/TerminalWorkspace.tsx");
  const { emptyWorkspace, groupSessions } = await load("lib/workspace.ts");
  let worktreeReads = 0;
  let workspace = emptyWorkspace();
  workspace = groupSessions(
    {
      ...workspace,
      selectedProject: "p",
      selectedSession: "a",
      projects: [
        {
          id: "p",
          name: "Project",
          directory: "/project",
          workspaceId: workspace.selectedWorkspace,
          worktrees: [
            {
              get id() {
                worktreeReads++;
                return "tree";
              },
              name: "Tree",
              path: "/tree",
              branch: "feature",
            },
          ],
          sessions: ["a", "b"].map((id) => ({
            id,
            name: id,
            shell: "default",
            worktreeId: "tree",
          })),
        },
      ],
    },
    "b",
    "a",
  );
  let props = {
    zoomed: false,
    focusRequest: 0,
    closeRequest: null,
    agentStates: {},
    onSessionViewed() {},
    onDetectedAgent() {},
    onAgentState() {},
    onClosed() {},
    update(change) {
      workspace = change(workspace);
    },
  };
  const render = () =>
    act(async () => root.render(React.createElement(TerminalWorkspace, { ...props, workspace })));
  const terminal = (id) => globalThis.workspaceTerminalProps.get(id);
  await render();
  let reads = worktreeReads;
  const frame = terminal("a").frame;
  assert.equal(terminal("a").directory, "/tree");
  props = { ...props, agentStates: { b: "busy" }, focusRequest: 1 };
  await render();
  assert.equal(worktreeReads, reads);
  assert.equal(terminal("b").agentState, "busy");
  assert.equal(terminal("a").frame, frame);
  assert.match(terminal("a").focusRequest, /^1\//);

  const container = document.querySelector(".terminal-workspace");
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 });
  const separator = document.querySelector('[role="separator"]');
  const pointer = (name, x) =>
    act(async () =>
      separator.dispatchEvent(
        new dom.window.MouseEvent(name, { bubbles: true, button: 0, clientX: x }),
      ),
    );
  await pointer("pointerdown", 500);
  await pointer("pointermove", 700);
  assert.equal(terminal("a").frame.width, 0.7);
  assert.equal(worktreeReads, reads);
  await pointer("pointerup", 700);
  await render();
  assert.equal(terminal("a").frame.width, 0.7);
  reads = worktreeReads;

  workspace = { ...workspace, selectedSession: "a" };
  props = { ...props, zoomed: true, closeRequest: { id: "b", sequence: 2 } };
  await render();
  assert.equal(terminal("a").frame.width, 1);
  assert.equal(terminal("b").visible, false);
  assert.equal(terminal("b").closeRequest, 2);
  assert.equal(worktreeReads, reads);

  workspace = {
    ...workspace,
    projects: workspace.projects.map((project) => ({
      ...project,
      worktrees: [{ ...project.worktrees[0], path: "/new tree" }],
    })),
  };
  await render();
  assert.equal(terminal("a").directory, "/new tree");
  workspace = {
    ...workspace,
    groups: workspace.groups.map((group) => ({
      ...group,
      terminals: [{ id: "loose", name: "Loose", shell: "default", directory: "/loose" }],
    })),
  };
  await render();
  assert.equal(terminal("loose").directory, "/loose");
  assert.deepEqual([...globalThis.workspaceTerminalMounts.values()], [1, 1, 1]);
});

test("sidebar lookup work is linear and activity updates reuse ordering without hiding edits", async (t) => {
  const { root, load } = await setup(t);
  const { Sidebar } = await load("components/Sidebar.tsx");
  const { SettingsProvider, useSettings } = await load("lib/SettingsContext.tsx");
  const { defaults, settingsKey } = await load("lib/settings.ts");
  const { emptyWorkspace, groupSessions, readWorkspace } = await load("lib/workspace.ts");
  const { setUiLanguage } = await load("lib/i18n.ts");
  localStorage.setItem(
    settingsKey,
    JSON.stringify({ ...defaults, language: "en", projectOrder: "name" }),
  );
  setUiLanguage("en");
  const count = 120;
  let idReads = 0;
  let sorts = 0;
  const compare = String.prototype.localeCompare;
  String.prototype.localeCompare = function (...args) {
    if (this.startsWith("Perf")) sorts++;
    return compare.apply(this, args);
  };
  t.after(() => {
    String.prototype.localeCompare = compare;
  });
  let workspace = emptyWorkspace();
  workspace = {
    ...workspace,
    projects: Array.from({ length: count }, (_, p) => ({
      get id() {
        idReads++;
        return `p${p}`;
      },
      name: `Perf ${String(count - p).padStart(3, "0")}`,
      directory: `/project/${p}`,
      workspaceId: workspace.selectedWorkspace,
      collapsed: true,
      sessions: [],
    })),
  };
  let saveSettings;
  function Configure() {
    const { settings, save } = useSettings();
    saveSettings = (patch) => save({ ...settings, ...patch }, true);
    return null;
  }
  const noop = () => {};
  let props = {
    visible: true,
    toggleVisibility: noop,
    closeSession: noop,
    runtime: { platform: "macos", agents: [], agent_definitions: [] },
    update: noop,
    focus: noop,
    menu: noop,
    addProject: noop,
    newWorkspace: noop,
    renameWorkspace: noop,
    addLoose: noop,
    addSession: noop,
    agentStates: {},
    detectedAgents: {},
    unreadCompletedSessions: new Set(),
    onSessionViewed: noop,
    onActivitySession: noop,
    footerActions: null,
  };
  const render = () =>
    act(async () =>
      root.render(
        React.createElement(
          SettingsProvider,
          null,
          React.createElement(Configure),
          React.createElement(Sidebar, { ...props, workspace }),
        ),
      ),
    );
  const names = () =>
    [...document.querySelectorAll("[data-project-id] .sidebar-row-name")].map(
      (node) => node.textContent,
    );
  await render();
  assert.equal(names().length, count);
  assert.equal(names()[0], "Perf 001");
  assert.ok(idReads < count * 40, `project ID reads: ${idReads}`);
  assert.ok(sorts > 0);
  sorts = 0;
  props = { ...props, agentStates: { background: "busy" } };
  workspace = { ...workspace, selectedSession: null };
  await render();
  assert.equal(sorts, 0);
  workspace = {
    ...workspace,
    projects: workspace.projects.map((project, index) =>
      index ? project : { ...project, name: "Perf 000", pinned: true },
    ),
  };
  await render();
  assert.equal(names()[0], "Perf 000");
  assert.ok(sorts > 0);
  await act(async () => saveSettings({ projectOrder: "manual" }));
  assert.deepEqual(names().slice(0, 3), ["Perf 000", "Perf 119", "Perf 118"]);
  workspace = { ...workspace, selectedWorkspace: "other" };
  await render();
  assert.deepEqual(names(), []);

  const source = emptyWorkspace();
  const projectId = `loose:${source.selectedWorkspace}:terminals`;
  workspace = readWorkspace(
    JSON.stringify(
      groupSessions(
        {
          ...source,
          selectedProject: projectId,
          selectedSession: "collision-a",
          projects: [
            {
              id: projectId,
              name: "Collision project",
              directory: "/collision",
              workspaceId: source.selectedWorkspace,
              sessions: ["collision-a", "collision-b"].map((id) => ({
                id,
                name: id,
                shell: "default",
              })),
            },
          ],
        },
        "collision-b",
        "collision-a",
      ),
    ),
  );
  await render();
  assert.equal(document.querySelectorAll(".group-mark").length, 2);
});
