import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";

test("sidebar connection toggles persist independently, retain active data and report storage failures", async () => {
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
              addSsh: record,
              selectSsh: record,
              addDatabase: record,
              selectDatabase: record,
              addRedis: record,
              selectRedis: record,
              redisStatuses: { redis: { connected: true, dirty: true, opening: false } },
              selectedRedisId: "redis",
            }),
          ),
        ),
      );
    const section = (name) => document.querySelector(`section[aria-label="${name} connections"]`);
    const toggle = (name) =>
      document.querySelector(`.sidebar-footer button[aria-label="${name} connections"]`);
    const click = (name) => act(async () => toggle(name).click());
    await render();
    assert.ok(section("Database"));
    assert.equal(toggle("Database").getAttribute("aria-pressed"), "true");
    await click("Database");
    assert.equal(section("Database"), null);
    assert.ok(section("Redis"));
    assert.ok(section("SSH"));
    assert.ok(section("Redis"));
    assert.equal(toggle("SSH").getAttribute("aria-pressed"), "true");
    assert.equal(toggle("Redis").title, "Hide Redis connections");
    await click("SSH");
    assert.equal(section("SSH"), null);
    assert.ok(section("Redis"));
    assert.equal(toggle("SSH").getAttribute("aria-pressed"), "false");
    assert.equal(toggle("SSH").title, "Show SSH connections");
    await click("Redis");
    assert.equal(section("Redis"), null);
    assert.equal(JSON.parse(localStorage.getItem(settingsKey)).showRedisConnections, false);
    providerKey++;
    await render();
    assert.equal(section("SSH"), null);
    assert.equal(section("Redis"), null);
    assert.equal(section("Database"), null);
    dom.window.Storage.prototype.setItem = () => {
      throw new Error("storage unavailable");
    };
    await click("SSH");
    assert.match(document.querySelector('[role="alert"]').textContent, /storage unavailable/);
    assert.equal(section("SSH"), null);
    dom.window.Storage.prototype.setItem = setItem;
    await click("SSH");
    assert.ok(section("SSH"));
    assert.match(section("SSH").textContent, /Remote shell/);
    assert.equal(section("Redis"), null);
    assert.equal(document.querySelector('[role="alert"]'), null);
    await click("Redis");
    assert.match(section("Redis").textContent, /Redis QA \*/);
    assert.equal(JSON.stringify(workspace), originalWorkspace);
    assert.deepEqual(actions, []);
    await act(async () => settings.save({ ...settings.settings, language: "zh-Hans" }, true));
    const chineseSsh = document.querySelector('.sidebar-footer button[aria-label="SSH 连接"]');
    assert.equal(chineseSsh.title, "隐藏 SSH 连接");
    assert.equal(chineseSsh.getAttribute("aria-pressed"), "true");
    await act(async () => chineseSsh.click());
    assert.equal(chineseSsh.title, "显示 SSH 连接");
    assert.equal(document.querySelector('section[aria-label="SSH 连接"]'), null);
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
