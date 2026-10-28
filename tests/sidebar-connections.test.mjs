import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";

test("sidebar folding and add actions retain active data regardless of legacy visibility settings", async () => {
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
    const { showSshConnections, showRedisConnections, showDatabaseConnections, ...oldSettings } =
      defaults;
    localStorage.setItem(settingsKey, JSON.stringify({ ...oldSettings, language: "en" }));
    const workspace = emptyWorkspace();
    workspace.groups[0].sshConnections = [
      {
        id: "ssh",
        name: "SSH QA",
        host: "qa",
        os: "posix",
        root: "",
        sessions: [{ id: "ssh-session", name: "Remote shell", shell: "default" }],
      },
    ];
    workspace.groups[0].redisConnections = [
      { id: "redis", name: "Redis QA", host: "127.0.0.1", port: 6379 },
    ];
    workspace.groups[0].databaseConnections = [
      {
        id: "database",
        name: "Database QA",
        kind: "mysql",
        host: "127.0.0.1",
        port: 3306,
        database: "",
        username: "",
        tls: true,
        ca_file: "",
        credential_id: null,
      },
    ];
    workspace.selectedSession = "ssh-session";
    const originalWorkspace = JSON.stringify(workspace);
    const actions = [];
    const record = () => actions.push("connection or workspace action");
    let providerKey = 0;
    let settings;
    function Probe() {
      settings = useSettings();
      return null;
    }
    const render = () =>
      act(async () =>
        root.render(
          React.createElement(
            SettingsProvider,
            { key: providerKey },
            React.createElement(Probe),
            React.createElement(Sidebar, {
              visible: true,
              toggleVisibility: record,
              closeSession: record,
              workspace,
              runtime: { platform: "macos" },
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
              footerActions: null,
              addSsh: () => actions.push("add SSH"),
              selectSsh: record,
              addDatabase: () => actions.push("add database"),
              manageDatabase: record,
              selectDatabase: record,
              addRedis: () => actions.push("add Redis"),
              selectRedis: record,
              redisStatuses: { redis: { connected: true, dirty: true, opening: false } },
              selectedRedisId: "redis",
              databaseStatuses: { database: { connected: true, busy: true, dirty: true } },
              selectedDatabaseId: "database",
            }),
          ),
        ),
      );
    const section = (name) =>
      document.querySelector(`section[aria-label="${name === "Database" ? "Databases" : name}"]`);
    const heading = (name) => section(name).querySelector(".section-header .section-toggle");
    await render();
    const originalSettings = localStorage.getItem(settingsKey);
    for (const name of ["SSH", "Redis", "Database"]) {
      assert.equal(heading(name).textContent, name === "Database" ? "Databases" : name);
      assert.equal(heading(name).getAttribute("aria-expanded"), "true");
      assert.ok(section(name).querySelector(".row-label"));
      await act(async () => heading(name).click());
      assert.equal(heading(name).getAttribute("aria-expanded"), "false");
      assert.equal(section(name).querySelector(".row-label"), null);
      assert.equal(
        section(name).querySelector('.section-header-actions button[aria-label^="Add"]').disabled,
        false,
      );
    }
    assert.equal(
      section("Database").querySelector('button[aria-label="Database components"]').disabled,
      false,
    );
    assert.equal(
      document
        .querySelector('section[aria-label="Projects"] .section-toggle')
        .getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(JSON.stringify(workspace), originalWorkspace);
    assert.equal(localStorage.getItem(settingsKey), originalSettings);
    assert.deepEqual(actions, []);
    const addTrigger = () =>
      document.querySelector('.sidebar-rail-footer button[aria-haspopup="menu"]');
    const addItems = () => [...document.querySelectorAll('.sidebar-popover.add [role="menuitem"]')];
    const connectionAdds = [
      "Add SSH connection",
      "Add Redis connection",
      "Add database connection",
    ];
    await act(async () => addTrigger().click());
    assert.deepEqual(
      addItems()
        .slice(0, 5)
        .map((item) => item.textContent),
      ["New terminal", "Add project…", ...connectionAdds],
    );
    for (let mask = 0; mask < 8; mask++) {
      await act(async () =>
        settings.save(
          {
            ...settings.settings,
            showSshConnections: !!(mask & 1),
            showRedisConnections: !!(mask & 2),
            showDatabaseConnections: !!(mask & 4),
          },
          true,
        ),
      );
      assert.deepEqual(
        addItems().map((item) => item.textContent),
        ["New terminal", "Add project…", ...connectionAdds],
      );
      assert.deepEqual(actions, []);
      assert.equal(JSON.stringify(workspace), originalWorkspace);
    }
    const allVisibleSettings = localStorage.getItem(settingsKey);
    for (const [index, name] of connectionAdds.entries()) {
      if (index > 0) await act(async () => addTrigger().click());
      await act(async () =>
        addItems()
          .find((item) => item.textContent === name)
          .click(),
      );
      assert.equal(document.querySelector(".sidebar-popover.add"), null);
      assert.equal(addTrigger().getAttribute("aria-expanded"), "false");
      assert.deepEqual(actions.splice(0), [["add SSH", "add Redis", "add database"][index]]);
    }
    assert.equal(localStorage.getItem(settingsKey), allVisibleSettings);
    assert.equal(heading("SSH").getAttribute("aria-expanded"), "false");
    for (const name of ["SSH", "Redis", "Database"]) {
      await act(async () => heading(name).click());
      assert.equal(heading(name).getAttribute("aria-expanded"), "true");
      assert.ok(section(name).querySelector(".row-label"));
    }
    assert.match(section("SSH").textContent, /Remote shell/);
    assert.match(section("Redis").textContent, /Redis QA \*/);
    assert.match(section("Database").textContent, /Database QA \*/);
    assert.ok(section("Redis").querySelector(".sidebar-row.selected"));
    assert.ok(section("Database").querySelector(".sidebar-row.selected"));
    assert.ok(section("Database"));
    providerKey++;
    await render();
    for (const name of ["SSH", "Redis", "Database"]) assert.ok(section(name));
    assert.equal(JSON.stringify(workspace), originalWorkspace);
    assert.deepEqual(actions, []);
    await act(async () => settings.save({ ...settings.settings, language: "zh-Hans" }, true));
    await act(async () => addTrigger().click());
    assert.deepEqual(
      addItems().map((item) => item.textContent),
      ["新建终端", "添加项目…", "添加 SSH 连接", "添加 Redis 连接", "添加数据库连接"],
    );
    await act(async () => addTrigger().click());
    const chineseDatabase = document.querySelector('section[aria-label="数据库"] .section-toggle');
    assert.equal(chineseDatabase.textContent, "数据库");
    await act(async () => chineseDatabase.click());
    assert.equal(chineseDatabase.getAttribute("aria-expanded"), "false");
    assert.equal(document.querySelector('section[aria-label="数据库"] .row-label'), null);
    assert.equal(
      document.querySelector('section[aria-label="Redis"] .section-toggle').textContent,
      "Redis",
    );
    workspace.groups[0].sshConnections = [];
    workspace.groups[0].redisConnections = [];
    workspace.groups.push({
      ...workspace.groups[0],
      id: "other",
      name: "Other",
      databaseConnections: [],
    });
    workspace.selectedSession = null;
    await render();
    await act(async () => document.querySelector(".workspace-switcher").click());
    assert.equal(
      [...document.querySelectorAll('[role="menuitem"]')].some(
        (item) => item.textContent === "移除工作区",
      ),
      false,
    );
    workspace.groups[0].databaseConnections = [];
    await render();
    assert.ok(
      [...document.querySelectorAll('[role="menuitem"]')].some(
        (item) => item.textContent === "移除工作区",
      ),
    );
  } finally {
    dom.window.Storage.prototype.setItem = setItem;
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
