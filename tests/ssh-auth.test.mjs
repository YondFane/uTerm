import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import {
  emptyWorkspace,
  readWorkspace,
  sshTargetFor,
  validSshTarget,
  reconcileSshSessions,
} from "../src/lib/workspace.ts";
import { validRedisConfig } from "../src/lib/redis.ts";

const reference = "22222222-2222-4222-8222-222222222222";
const connection = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "SSH QA",
  host: "127.0.0.1",
  mode: "direct",
  port: 2222,
  username: "qa",
  authentication: "password",
  credential_id: reference,
  remember_password: true,
  os: "posix",
  root: "",
  sessions: [],
};
test("SSH options and Redis tunnels survive schema 6 storage while rejecting plaintext credentials", () => {
  const workspace = emptyWorkspace();
  workspace.groups[0].sshConnections = [connection];
  const target = sshTargetFor(connection, workspace.groups[0].id);
  const redis = {
    id: crypto.randomUUID(),
    name: "Tunnel",
    host: "127.0.0.1",
    port: 6379,
    db: 0,
    username: "",
    tls: false,
    ca_file: "",
    server_name: "",
    ssh_host: connection.host,
    ssh_target: target,
    credential_id: null,
  };
  workspace.groups[0].redisConnections = [redis];
  const restored = readWorkspace(JSON.stringify(workspace));
  assert.deepEqual(restored.groups[0].redisConnections, [redis]);
  assert.deepEqual(restored.groups[0].sshConnections[0], { ...connection, splitGroups: [] });
  assert.deepEqual(readWorkspace(JSON.stringify(restored)), restored);
  assert.equal(validRedisConfig(redis), true);
  assert.equal(validRedisConfig({ ...redis, ssh_host: "other" }), false);
  for (const bad of [
    { port: 0 },
    { port: 65536 },
    { username: "qa\n" },
    { identity_file: "key\0" },
    { credential_id: "secret" },
    { password: "secret" },
    { private_key: "secret" },
    { host: undefined },
  ]) {
    assert.equal(validSshTarget({ ...target, ...bad }), false);
    assert.equal(validRedisConfig({ ...redis, ssh_target: { ...target, ...bad } }), false);
  }
  for (const version of [3, 4, 5, 6])
    assert.equal(readWorkspace(JSON.stringify({ ...emptyWorkspace(), version })).version, 7);
  const discovered = reconcileSshSessions(emptyWorkspace(), {
    closed: [],
    sessions: [{ id: "remote", directory: "/local", shell: "default", agent: null, ssh: target }],
  });
  assert.equal(discovered.groups[0].sshConnections[0].credential_id, reference);
  assert.equal(discovered.groups[0].sshConnections[0].port, 2222);
  assert.equal(JSON.stringify(workspace).includes('"password":'), false);
});

async function setup() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLDialogElement",
    "localStorage",
  ])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const { SshConnectionDialog } = await server.ssrLoadModule(
    "/src/components/SshConnectionDialog.tsx",
  );
  const { RedisConnectionDialog } = await server.ssrLoadModule(
    "/src/components/RedisConnectionDialog.tsx",
  );
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  return {
    dom,
    root,
    SshConnectionDialog,
    RedisConnectionDialog,
    async cleanup() {
      await act(async () => root.unmount());
      clearMocks();
      await server.close();
      dom.window.close();
    },
  };
}
async function change(node, value) {
  await act(async () => {
    const proto =
      node.tagName === "SELECT"
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
    node.dispatchEvent(
      new window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  });
}
test("SSH dialog keeps existing aliases, rolls back new credentials on failed storage and never saves plaintext", async () => {
  const view = await setup();
  const calls = [];
  const saved = [];
  let accept = false;
  let closed = 0;
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "ssh_info") return { available: true, aliases: ["lab"] };
    if (command === "ssh_configure_auth") return reference;
    if (command === "ssh_pick_identity") return "/keys/qa key";
    return null;
  });
  const legacy = { id: "legacy", name: "Lab", host: "lab", os: "posix", root: "", sessions: [] };
  try {
    await act(async () =>
      view.root.render(
        React.createElement(view.SshConnectionDialog, {
          connection: legacy,
          workspaceId: "local",
          save: (value) => {
            saved.push(value);
            return accept;
          },
          close: () => closed++,
        }),
      ),
    );
    const selects = document.querySelectorAll("select");
    assert.equal(selects[0].value, "alias");
    assert.equal(selects[1].value, "config");
    assert.equal(document.querySelector('input[type="number"]').value, "");
    await change(selects[0], "direct");
    assert.equal(document.querySelector('input[type="number"]').value, "22");
    await change(document.querySelectorAll("input")[1], "127.0.0.1");
    await change(document.querySelector('input[type="number"]'), "2222");
    await change(selects[1], "key");
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((v) => v.textContent === "Choose file…")
        .click(),
    );
    assert.equal(document.querySelector(".ssh-key-picker input").value, "/keys/qa key");
    await change(selects[1], "password");
    await change(document.querySelector('input[type="password"]'), "fixture-secret");
    await act(async () => document.querySelector('input[type="checkbox"]').click());
    const submit = () =>
      act(async () =>
        document
          .querySelector("form")
          .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
      );
    await submit();
    assert.equal(closed, 0);
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /Could not save the connection/,
    );
    assert.equal(
      calls.find((v) => v.command === "ssh_configure_auth").args.password,
      "fixture-secret",
    );
    assert.deepEqual(calls.find((v) => v.command === "ssh_forget_auth").args, {
      reference,
      remember: true,
    });
    assert.equal(saved[0].credential_id, reference);
    assert.equal(saved[0].remember_password, true);
    assert.equal(saved[0].port, 2222);
    assert.equal(JSON.stringify(saved).includes("fixture-secret"), false);
    accept = true;
    await submit();
    assert.equal(closed, 1);
  } finally {
    await view.cleanup();
  }
});
test("Redis SSH selection retains a full profile snapshot and clears it for direct connections", async () => {
  const view = await setup();
  const saved = [];
  mockIPC(() => null);
  try {
    await act(async () =>
      view.root.render(
        React.createElement(view.RedisConnectionDialog, {
          workspaceId: "local",
          ssh: [connection],
          save: (value) => {
            saved.push(value);
            return true;
          },
          close() {},
        }),
      ),
    );
    const select = document.querySelector("select");
    await change(select, connection.id);
    await act(async () =>
      document
        .querySelector("form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(saved[0].ssh_target.port, 2222);
    assert.equal(saved[0].ssh_target.credential_id, reference);
    await change(select, "");
    await act(async () =>
      document
        .querySelector("form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(saved[1].ssh_target, undefined);
    assert.equal(saved[1].ssh_host, "");
  } finally {
    await view.cleanup();
  }
});
