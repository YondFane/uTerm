import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";

test("sidebar navigation filters existing lists without changing sessions, profiles or selection", async () => {
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
  const setItem = dom.window.Storage.prototype.setItem;
  try {
    const { Sidebar } = await server.ssrLoadModule("/src/components/Sidebar.tsx");
    const { SettingsProvider, useSettings } = await server.ssrLoadModule(
      "/src/lib/SettingsContext.tsx",
    );
    const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
    const { emptyWorkspace } = await server.ssrLoadModule("/src/lib/workspace.ts");
    const { translate } = await server.ssrLoadModule("/src/lib/i18n.ts");
    const workspace = emptyWorkspace();
    const group = workspace.groups[0];
    workspace.projects = [
      {
        id: "project",
        name: "Project",
        directory: "D:/fixture",
        workspaceId: group.id,
        sessions: [{ id: "shell", name: "Shell", shell: "default" }],
      },
    ];
    workspace.selectedProject = "project";
    workspace.selectedSession = "shell";
    group.sshConnections = [
      { id: "ssh", name: "Remote", host: "example.invalid", os: "posix", root: "", sessions: [] },
    ];
    group.redisConnections = [
      { id: "redis", name: "Redis fixture", host: "localhost", port: 6379 },
    ];
    group.databaseConnections = [
      { id: "database", name: "Database fixture", host: "localhost", port: 3306, kind: "mysql" },
    ];
    const original = JSON.stringify(workspace);
    const actions = [];
    const record = () => actions.push("action");
    let context;
    let key = 0;
    function Harness() {
      context = useSettings();
      return React.createElement(Sidebar, {
        visible: true,
        toggleVisibility: record,
        closeSession: record,
        workspace,
        runtime: { platform: "windows", agents: [], agent_definitions: [] },
        update: record,
        focus: record,
        menu: record,
        addProject: record,
        newWorkspace: record,
        renameWorkspace: record,
        addLoose: record,
        addSession: record,
        agentStates: {},
        detectedAgents: {},
        unreadCompletedSessions: new Set(),
        onSessionViewed: record,
        onActivitySession: record,
        addSsh: record,
        addRedis: record,
        addDatabase: record,
        redisStatuses: { redis: { connected: true } },
        databaseStatuses: { database: { connected: true } },
        footerActions: React.createElement(
          "div",
          { className: "sidebar-footer-actions" },
          React.createElement("button", { onClick: record, "aria-label": "Settings" }, "Settings"),
        ),
      });
    }
    const render = () =>
      act(async () =>
        root.render(React.createElement(SettingsProvider, { key }, React.createElement(Harness))),
      );
    const save = (patch) => act(async () => context.save({ ...context.settings, ...patch }, false));
    const nav = (name) =>
      document.querySelector(`.sidebar-rail [aria-label="${translate("en", name)}"]`);
    const click = (element) => act(async () => element.click());
    const section = (name) =>
      document.querySelector(`#sidebar-sections section[aria-label="${translate("en", name)}"]`);
    localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
    await render();
    assert.equal(document.querySelector(".sidebar-rail"), null);
    assert.ok(document.querySelector('.sidebar-footer [aria-label="Settings"]'));
    assert.equal(document.querySelectorAll(".sidebar-connection-toggles button").length, 3);
    assert.ok(document.querySelector(".sidebar-footer .sidebar-add"));
    await save({ sidebarStyle: "navigation" });
    assert.equal(document.querySelectorAll(".sidebar-rail-items button").length, 5);
    assert.equal(nav("全部").getAttribute("aria-pressed"), "true");
    assert.ok(document.querySelector('.sidebar-rail [aria-label="Settings"]'));
    assert.equal(document.querySelector(".sidebar-footer"), null);
    assert.equal(document.querySelector(".sidebar-connection-toggles"), null);
    assert.equal(document.querySelectorAll(".sidebar-add").length, 1);
    const add = document.querySelector(".sidebar-rail-footer .sidebar-add");
    assert.ok(add);
    await click(add);
    assert.ok(document.querySelector('[aria-label="Add menu"]'));
    assert.equal(add.getAttribute("aria-expanded"), "true");
    await act(async () =>
      window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })),
    );
    assert.equal(document.querySelector('[aria-label="Add menu"]'), null);
    assert.equal(document.activeElement, add);
    await click(nav("SSH 连接"));
    assert.ok(section("SSH"));
    assert.equal(section("活动"), null);
    assert.equal(section("Redis"), null);
    await click(nav("项目与会话"));
    assert.ok(section("活动").querySelector('.session-row [aria-current="true"]'));
    assert.equal(section("SSH"), null);
    for (const [label, name] of [
      ["Redis 连接", "Redis"],
      ["数据库连接", "数据库"],
    ]) {
      await click(nav(label));
      assert.ok(section(name));
      assert.equal(section("活动"), null);
    }
    await save({ showDatabaseConnections: false });
    assert.equal(nav("数据库连接"), null);
    assert.equal(nav("全部").getAttribute("aria-pressed"), "true");
    assert.ok(section("活动"));
    await save({ showDatabaseConnections: true });
    await click(nav("Redis 连接"));
    dom.window.Storage.prototype.setItem = () => {
      throw Error("Storage denied");
    };
    assert.throws(
      () => context.save({ ...context.settings, showRedisConnections: false }, false),
      /Storage denied/,
    );
    assert.ok(section("Redis"));
    assert.equal(nav("Redis 连接").getAttribute("aria-pressed"), "true");
    dom.window.Storage.prototype.setItem = setItem;
    await save({ sidebarStyle: "classic" });
    assert.equal(document.querySelector(".sidebar-rail"), null);
    assert.equal(document.querySelectorAll(".sidebar-connection-toggles button").length, 3);
    assert.ok(document.querySelector(".sidebar-footer .sidebar-add"));
    assert.ok(section("SSH"));
    assert.ok(section("Redis"));
    assert.ok(section("数据库"));
    await save({ sidebarStyle: "navigation" });
    key++;
    await render();
    assert.ok(document.querySelector(".sidebar-rail"));
    assert.equal(nav("全部").getAttribute("aria-pressed"), "true");
    assert.equal(context.settings.sidebarStyle, "navigation");
    assert.equal(JSON.stringify(workspace), original);
    assert.deepEqual(actions, []);
  } finally {
    dom.window.Storage.prototype.setItem = setItem;
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
