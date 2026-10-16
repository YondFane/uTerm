import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";

test("connection context menus target their row, retain edit guards and dismiss stale targets", async () => {
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
    const { SettingsProvider, useSettings } = await server.ssrLoadModule(
      "/src/lib/SettingsContext.tsx",
    );
    const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
    const { emptyWorkspace } = await server.ssrLoadModule("/src/lib/workspace.ts");
    localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
    const workspace = emptyWorkspace();
    const group = workspace.groups[0];
    group.sshConnections = ["first", "second"].map((id) => ({
      id,
      name: `SSH ${id}`,
      host: "example.invalid",
      os: "posix",
      root: "",
      sessions: [],
    }));
    group.redisConnections = [{ id: "redis", name: "Redis QA", host: "localhost", port: 6379 }];
    group.databaseConnections = [
      { id: "database", name: "Database QA", host: "localhost", port: 3306, kind: "mysql" },
    ];
    const actions = [];
    const noop = () => {};
    let settings;
    function Probe() {
      settings = useSettings();
      return null;
    }
    const props = {
      visible: true,
      toggleVisibility: noop,
      closeSession: noop,
      workspace,
      runtime: { platform: "windows", agents: [], agent_definitions: [] },
      update: noop,
      focus: noop,
      menu: (value) => actions.push(["session-menu", value.id]),
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
      addSsh: noop,
      editSsh: (connection) => actions.push(["edit-ssh", connection.id]),
      newSshTerminal: (connection) => actions.push(["new-ssh", connection.id]),
      selectSsh: () => actions.push(["select-ssh"]),
      canEditSsh: () => true,
      canRemoveSsh: () => true,
      addRedis: noop,
      editRedis: (connection) => actions.push(["edit-redis", connection.id]),
      selectRedis: () => actions.push(["select-redis"]),
      addDatabase: noop,
      editDatabase: (connection) => actions.push(["edit-database", connection.id]),
      selectDatabase: () => actions.push(["select-database"]),
    };
    const render = () =>
      act(async () =>
        root.render(
          React.createElement(
            SettingsProvider,
            null,
            React.createElement(Probe),
            React.createElement(Sidebar, props),
          ),
        ),
      );
    const row = (name) =>
      [...document.querySelectorAll(".row-label")]
        .find((button) => button.textContent.replace(/^R/, "").replace(/ \*$/, "") === name)
        .closest(".sidebar-row");
    const popup = () => document.querySelector('[role="menu"]');
    const items = () => [...document.querySelectorAll('[role="menuitem"]')];
    const send = (target, type, options = {}) =>
      act(async () => {
        const Event = type === "keydown" ? dom.window.KeyboardEvent : dom.window.MouseEvent;
        const event = new Event(type, { bubbles: true, cancelable: true, ...options });
        target.dispatchEvent(event);
        if (type === "contextmenu") assert.equal(event.defaultPrevented, true);
      });
    const open = (name) => send(row(name), "contextmenu", { clientX: 1010, clientY: 760 });
    await render();
    for (const name of ["SSH first", "SSH second", "Redis QA", "Database QA"]) {
      assert.equal(row(name).querySelectorAll("button").length, 2);
      assert.match(row(name).querySelector(".icon-button").getAttribute("aria-label"), /^Remove/);
    }
    assert.equal(document.querySelector('button[title="New SSH terminal"]'), null);
    await open("SSH second");
    assert.deepEqual(actions, []);
    assert.deepEqual(
      items().map((item) => item.textContent),
      ["New SSH terminal", "Edit SSH connection"],
    );
    assert.equal(document.activeElement, items()[0]);
    assert.equal(popup().parentElement, document.body);
    assert.ok(parseFloat(popup().style.left) <= window.innerWidth - 8);
    assert.ok(parseFloat(popup().style.top) <= window.innerHeight - 8);
    await send(items()[0], "keydown", { key: "ArrowDown" });
    assert.equal(document.activeElement, items()[1]);
    await act(async () => items()[1].click());
    assert.deepEqual(actions.pop(), ["edit-ssh", "second"]);
    assert.equal(popup(), null);
    await open("SSH first");
    await act(async () => items()[0].click());
    assert.deepEqual(actions.pop(), ["new-ssh", "first"]);
    for (const [name, action] of [
      ["Redis QA", "edit-redis"],
      ["Database QA", "edit-database"],
    ]) {
      await open(name);
      await act(async () => items()[0].click());
      assert.deepEqual(actions.pop(), [action, action === "edit-redis" ? "redis" : "database"]);
    }
    props.canEditSsh = () => false;
    props.activityDisabled = true;
    await render();
    await open("SSH first");
    assert.ok(items().every((item) => item.disabled));
    assert.equal(document.activeElement, popup());
    await act(async () => items()[0].click());
    assert.deepEqual(actions, []);
    props.activityDisabled = false;
    await render();
    assert.equal(items()[0].disabled, false);
    assert.equal(items()[1].disabled, true);
    await send(popup(), "keydown", { key: "Escape" });
    assert.equal(popup(), null);
    assert.equal(document.activeElement, row("SSH first").querySelector(".row-label"));
    for (const [type, name, fields] of [
      ["redis", "Redis QA", ["connected", "opening", "dirty"]],
      ["database", "Database QA", ["connected", "busy", "dirty"]],
    ]) {
      for (const field of fields) {
        props[`${type}Statuses`] = { [type]: { [field]: true } };
        await render();
        await open(name);
        assert.equal(items()[0].disabled, true);
        await act(async () => items()[0].click());
        assert.deepEqual(actions, []);
      }
      props[`${type}Statuses`] = {};
      await render();
      assert.equal(items()[0].disabled, false);
    }
    await send(popup(), "keydown", { key: "Escape" });
    const sshLabel = row("SSH first").querySelector(".row-label");
    await send(sshLabel, "keydown", { key: "F10", shiftKey: true });
    assert.equal(items().length, 2);
    await send(popup(), "keydown", { key: "Escape" });
    assert.equal(document.activeElement, sshLabel);
    await send(sshLabel, "keydown", { key: "ContextMenu" });
    assert.equal(items().length, 2);
    await send(document.body, "pointerdown");
    assert.equal(popup(), null);
    for (const event of ["scroll", "resize", "blur"]) {
      await open("Redis QA");
      await act(async () =>
        (event === "scroll" ? document : window).dispatchEvent(new dom.window.Event(event)),
      );
      assert.equal(popup(), null);
    }
    await open("Redis QA");
    await act(async () => settings.save({ ...settings.settings, language: "zh-Hans" }, false));
    assert.equal(items()[0].textContent, "编辑 Redis 连接");
    await act(async () =>
      settings.save({ ...settings.settings, showRedisConnections: false }, false),
    );
    assert.equal(popup(), null);
    await open("Database QA");
    await act(async () =>
      document.querySelector('section[aria-label="数据库"] .section-toggle').click(),
    );
    assert.equal(popup(), null);
    await open("SSH first");
    group.sshConnections = group.sshConnections.filter((connection) => connection.id !== "first");
    await render();
    assert.equal(popup(), null);
    await open("SSH second");
    props.visible = false;
    await render();
    assert.equal(popup(), null);
    props.visible = true;
    await render();
    await open("SSH second");
    workspace.groups.push({ id: "other", name: "Other", sshConnections: group.sshConnections });
    workspace.selectedWorkspace = "other";
    await render();
    assert.equal(popup(), null);
    assert.deepEqual(actions, []);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
