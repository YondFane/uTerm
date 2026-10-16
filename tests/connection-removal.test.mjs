import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";

test("connection removal requires confirmation, preserves cancellation and rechecks live protections in both languages", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
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
    const connections = {
      ssh: { id: "ssh", name: "SSH 中文 QA", host: "qa", root: "", sessions: [] },
      redis: { id: "redis", name: "Redis 中文 QA", host: "127.0.0.1", port: 6379 },
      database: {
        id: "database",
        name: "MySQL 中文 QA",
        host: "127.0.0.1",
        port: 3306,
        kind: "mysql",
      },
    };
    group.sshConnections = [connections.ssh];
    group.redisConnections = [connections.redis];
    group.databaseConnections = [connections.database];
    const original = JSON.stringify(workspace);
    const removals = [];
    let preferences;
    let sshRemovable = true;
    const noop = () => {};
    const props = {
      visible: true,
      workspace,
      runtime: { platform: "windows" },
      toggleVisibility: noop,
      closeSession: noop,
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
      addSsh: noop,
      canRemoveSsh: () => sshRemovable,
      removeSsh: (connection) => removals.push({ kind: "ssh", connection }),
      addRedis: noop,
      removeRedis: (connection) => removals.push({ kind: "redis", connection }),
      redisStatuses: {},
      addDatabase: noop,
      removeDatabase: (connection) => removals.push({ kind: "database", connection }),
      databaseStatuses: {},
    };
    function Harness() {
      preferences = useSettings();
      return React.createElement(Sidebar, props);
    }
    const render = () =>
      act(async () =>
        root.render(React.createElement(SettingsProvider, null, React.createElement(Harness))),
      );
    const dialog = () => document.querySelector(".connection-removal-dialog");
    const click = (button) =>
      act(async () => {
        button.focus();
        button.click();
      });
    const removeButton = (kind) => {
      const label =
        preferences.settings.language === "en"
          ? {
              ssh: "Remove SSH connection",
              redis: "Remove Redis connection",
              database: "Remove database connection",
            }[kind]
          : { ssh: "移除 SSH 连接", redis: "移除 Redis 连接", database: "移除数据库连接" }[kind];
      return (
        document.querySelector(`button[aria-label="${label}: ${connections[kind].name}"]`) ??
        document.querySelector(`button[aria-label="${label}：${connections[kind].name}"]`)
      );
    };
    await render();
    for (const language of ["en", "zh-Hans"]) {
      await act(async () => preferences.save({ ...preferences.settings, language }));
      for (const kind of ["ssh", "redis", "database"]) {
        const count = removals.length;
        const trigger = removeButton(kind);
        await click(trigger);
        assert.ok(dialog().open);
        assert.ok(dialog().textContent.includes(connections[kind].name));
        assert.equal(dialog().querySelector("h2").textContent, trigger.title);
        assert.equal(removals.length, count);
        assert.equal(document.activeElement, dialog().querySelector('button[type="button"]'));
        assert.equal(document.activeElement.textContent, language === "en" ? "Cancel" : "取消");
        await click(document.activeElement);
        assert.equal(dialog(), null);
        assert.equal(document.activeElement, trigger);
        assert.equal(removals.length, count);
        await click(trigger);
        await act(async () =>
          dialog().dispatchEvent(new window.Event("cancel", { cancelable: true })),
        );
        assert.equal(dialog(), null);
        assert.equal(document.activeElement, trigger);
        assert.equal(removals.length, count);
        assert.equal(JSON.stringify(workspace), original);
        await click(trigger);
        assert.equal(
          dialog().querySelector('button[type="submit"]').textContent,
          language === "en" ? "Confirm removal" : "确认移除",
        );
        await click(dialog().querySelector('button[type="submit"]'));
        assert.equal(dialog(), null);
        assert.equal(removals.length, count + 1);
        assert.deepEqual(removals.at(-1), { kind, connection: connections[kind] });
      }
    }
    const confirmed = removals.length;
    for (const kind of ["ssh", "redis", "database"]) {
      const protections =
        kind === "ssh"
          ? ["inUse"]
          : kind === "redis"
            ? ["connected", "opening", "dirty"]
            : ["connected", "busy", "dirty"];
      for (const protection of protections) {
        await click(removeButton(kind));
        const oldSubmit = dialog().querySelector('button[type="submit"]');
        if (kind === "ssh") sshRemovable = false;
        else
          props[kind === "redis" ? "redisStatuses" : "databaseStatuses"][kind] = {
            [protection]: true,
          };
        await render();
        assert.equal(dialog(), null, `${kind} ${protection} cancels pending removal`);
        await click(oldSubmit);
        assert.equal(removals.length, confirmed);
        assert.equal(removeButton(kind).disabled, true);
        await click(removeButton(kind));
        assert.equal(dialog(), null);
        sshRemovable = true;
        props.redisStatuses = {};
        props.databaseStatuses = {};
        await render();
      }
    }
    await click(removeButton("ssh"));
    workspace.selectedWorkspace = "other";
    await render();
    assert.equal(dialog(), null, "Changing workspace cancels removal");
    workspace.selectedWorkspace = group.id;
    await render();
    await click(removeButton("ssh"));
    group.sshConnections = [{ ...connections.ssh, name: "Changed SSH target" }];
    await render();
    assert.equal(dialog(), null, "An edited profile invalidates its pending confirmation");
    group.sshConnections = [connections.ssh];
    await render();
    await click(removeButton("redis"));
    await act(async () =>
      preferences.save({ ...preferences.settings, showRedisConnections: false }),
    );
    assert.equal(dialog(), null, "Hiding the connection section cancels removal");
    await act(async () =>
      preferences.save({ ...preferences.settings, showRedisConnections: true }),
    );
    await click(removeButton("redis"));
    props.visible = false;
    await render();
    assert.equal(dialog(), null, "Hiding the sidebar cancels removal");
    props.visible = true;
    await render();
    await click(removeButton("database"));
    group.databaseConnections = [];
    await render();
    assert.equal(dialog(), null, "A missing profile cannot be removed again");
    assert.equal(removals.length, confirmed);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
