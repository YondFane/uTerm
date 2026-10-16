import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";

test("sidebar activity rings follow open sessions and successful connections instead of selection", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    const { Sidebar } = await server.ssrLoadModule("/src/components/Sidebar.tsx");
    const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
    const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
    const { emptyWorkspace } = await server.ssrLoadModule("/src/lib/workspace.ts");
    const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
    localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
    const session = (id, extra = {}) => ({ id, name: id, shell: "default", ...extra });
    const workspace = emptyWorkspace();
    const group = workspace.groups[0];
    workspace.projects = [
      {
        id: "active",
        name: "Active project",
        directory: "/active",
        workspaceId: group.id,
        pinned: true,
        sessions: [session("tree-session", { worktreeId: "tree", agent: "codex" })],
        worktrees: [
          { id: "tree", name: "Open tree", path: "/tree", branch: "tree" },
          { id: "unused", name: "Unused tree", path: "/unused", branch: "unused" },
        ],
      },
      {
        id: "idle",
        name: "Selected project",
        directory: "/idle",
        workspaceId: group.id,
        sessions: [],
      },
    ];
    workspace.selectedProject = "idle";
    group.sshConnections = [
      {
        id: "ssh-open",
        name: "Open SSH",
        host: "host",
        os: "posix",
        root: "",
        sessions: [session("ssh-session")],
      },
      { id: "ssh-idle", name: "Idle SSH", host: "idle", os: "posix", root: "", sessions: [] },
    ];
    group.redisConnections = ["connected", "opening", "selected"].map((id) => ({
      id,
      name: `Redis ${id}`,
      host: "localhost",
      port: 6379,
    }));
    group.databaseConnections = ["connected", "selected"].map((id) => ({
      id,
      name: `Database ${id}`,
      kind: "mysql",
      host: "localhost",
      port: 3306,
    }));
    const redisStatuses = {
      connected: { connected: true, opening: false, dirty: false },
      opening: { connected: false, opening: true, dirty: false },
      selected: { connected: false, opening: false, dirty: true },
    };
    const databaseStatuses = {
      connected: { connected: true, busy: false, dirty: false },
      selected: { connected: false, busy: true, dirty: true },
    };
    const noop = () => {};
    const render = () =>
      act(async () =>
        root.render(
          React.createElement(
            SettingsProvider,
            null,
            React.createElement(Sidebar, {
              visible: true,
              toggleVisibility: noop,
              closeSession: noop,
              workspace,
              runtime: null,
              update: noop,
              focus: noop,
              menu: noop,
              addProject: noop,
              newWorkspace: noop,
              renameWorkspace: noop,
              addLoose: noop,
              addSession: noop,
              agentStates: { "tree-session": "idle", "retained-exit": "error" },
              detectedAgents: {},
              unreadCompletedSessions: new Set(),
              onSessionViewed: noop,
              onActivitySession: noop,
              footerActions: null,
              addSsh: noop,
              addRedis: noop,
              addDatabase: noop,
              redisStatuses,
              databaseStatuses,
              selectedRedisId: "selected",
              selectedDatabaseId: "selected",
            }),
          ),
        ),
      );
    const folder = (name) =>
      [...document.querySelectorAll(".folder-row > .row-label")]
        .find((button) => button.textContent === name)
        ?.querySelector(".sidebar-resource-icon");
    const connection = (name) =>
      [...document.querySelectorAll(".row-label")]
        .find((button) => {
          const text = button.textContent.trim().replace(/ \*$/, "");
          return text === name || text === `R${name}`;
        })
        .querySelector(".sidebar-resource-icon");
    const active = (element) => element.hasAttribute("data-resource-active");
    const original = JSON.stringify(workspace);
    await render();
    assert.equal(active(folder("Active project")), true);
    assert.equal(active(folder("Open tree")), true);
    assert.equal(active(folder("Unused tree")), false);
    assert.equal(active(folder("Selected project")), false);
    assert.equal(
      folder("Open tree").parentElement.getAttribute("aria-description"),
      "Has open sessions",
    );
    assert.equal(active(connection("Open SSH")), true);
    assert.equal(active(connection("Idle SSH")), false);
    assert.equal(active(connection("Redis connected")), true);
    assert.equal(active(connection("Redis opening")), false);
    assert.equal(active(connection("Redis selected")), false);
    assert.equal(active(connection("Database connected")), true);
    assert.equal(active(connection("Database selected")), false);
    assert.equal(
      connection("Database connected").parentElement.getAttribute("aria-description"),
      "Connected",
    );
    await act(async () => folder("Active project").parentElement.click());
    assert.equal(active(folder("Active project")), true);
    assert.equal(JSON.stringify(workspace), original);
    await act(async () => folder("Active project").parentElement.click());
    workspace.projects[0].sessions = [session("retained-exit", { agent: "codex" })];
    group.sshConnections[0].sessions = [];
    redisStatuses.connected = { connected: false, opening: true, dirty: true };
    databaseStatuses.connected = { connected: false, busy: true, dirty: true };
    await render();
    assert.equal(active(folder("Active project")), true);
    assert.equal(active(folder("Open tree")), false);
    assert.equal(active(connection("Open SSH")), false);
    assert.equal(active(connection("Redis connected")), false);
    assert.equal(active(connection("Database connected")), false);
    assert.equal(
      connection("Database connected").parentElement.hasAttribute("aria-description"),
      false,
    );
    await act(async () => setUiLanguage("zh-Hans"));
    assert.equal(
      folder("Active project").parentElement.getAttribute("aria-description"),
      "有未关闭的会话",
    );
    workspace.projects[0].sessions = [];
    await render();
    assert.equal(document.querySelector("[data-resource-active]"), null);
    workspace.projects[0].sessions = [session("other-workspace")];
    workspace.selectedWorkspace = "other";
    workspace.groups.push({
      id: "other",
      name: "Other",
      selectedProject: null,
      selectedSession: null,
    });
    await render();
    assert.equal(document.querySelector("[data-resource-active]"), null);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
