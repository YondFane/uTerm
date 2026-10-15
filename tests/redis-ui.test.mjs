import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

const config = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Redis QA",
  host: "127.0.0.1",
  port: 6379,
  db: 0,
  username: "",
  tls: false,
  ca_file: "",
  server_name: "",
  ssh_host: "",
  credential_id: null,
};
async function setup() {
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
        name: "redis-test-editor",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/FileEditor")) return "\0redis-editor";
        },
        load(id) {
          if (id === "\0redis-editor")
            return `import React from 'react'; export function CodeEditor(props) { globalThis.redisEditorProps = props; return React.createElement('textarea', { readOnly: props.document.readonly, value: props.document.text, onChange: event => props.change(event.target.value) }); }`;
        },
      },
    ],
  });
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const { RedisWorkspace } = await server.ssrLoadModule("/src/components/RedisWorkspace.tsx");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  return {
    dom,
    server,
    root,
    RedisWorkspace,
    async cleanup() {
      await act(async () => root.unmount());
      clearMocks();
      await server.close();
      dom.window.close();
      delete globalThis.redisEditorProps;
    },
  };
}
function button(text, scope = document) {
  const result = [...scope.querySelectorAll("button")].find((item) => item.textContent === text);
  assert.ok(result, `Missing button ${text}`);
  return result;
}
test("Redis workbench starts read-only, retains hidden drafts and prevents conflicting saves or accidental disconnects", async () => {
  const view = await setup();
  const key = {
    data: Buffer.from("key").toString("base64"),
    text: "key",
    size: 3,
    truncated: false,
  };
  const calls = [];
  let conflict = true;
  let binaryStage = false;
  const binaryKey = {
    data: Buffer.from([0, 255]).toString("base64"),
    text: null,
    size: 2,
    truncated: false,
  };
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "redis_connect") return { handle: "connection", db: 0 };
    if (command === "redis_reconnect") return { handle: "reconnected", db: 0 };
    if (command === "redis_request") {
      if (args.request.op === "console")
        return { result: { text: "redis_version:7.4.0", data: "", size: 20, truncated: false } };
      if (args.request.op === "scan")
        return {
          cursor: "0",
          entries: [
            { key, kind: "string", ttl: 50000 },
            { key, kind: "string", ttl: 50000 },
            ...(binaryStage ? [{ key: binaryKey, kind: "hash", ttl: -1 }] : []),
          ],
        };
      if (args.request.op === "read" && args.request.key === binaryKey.data)
        return { kind: "hash", ttl: -1, db: 0, size: 1, items: [], cursor: "0" };
      if (args.request.op === "read")
        return {
          kind: "string",
          ttl: 50000,
          db: 0,
          size: 8,
          value: {
            data: Buffer.from("original").toString("base64"),
            text: "original",
            size: 8,
            truncated: false,
          },
          version: "a".repeat(64),
        };
      if (args.request.op === "save") {
        if (conflict) throw new Error("REDIS_CONFLICT");
        return { version: "b".repeat(64) };
      }
    }
    if (
      ["redis_writable", "redis_guard", "redis_disconnect"].includes(command) ||
      command.startsWith("plugin:event|")
    )
      return null;
    throw new Error(`Unexpected command ${command}`);
  });
  const props = (active) => ({ config, active, password: "temporary-secret", consumed() {} });
  try {
    await act(async () => view.root.render(React.createElement(view.RedisWorkspace, props(true))));
    assert.equal(
      calls.filter((call) => call.command === "redis_connect").length,
      0,
      "Restoring a profile never connects automatically",
    );
    await act(async () => button("Connect").click());
    assert.equal(
      calls.find((call) => call.command === "redis_connect").args.password,
      "temporary-secret",
    );
    assert.equal(
      document.querySelectorAll(".redis-key").length,
      1,
      "SCAN duplicates are deduplicated",
    );
    assert.equal(document.querySelector('input[type="checkbox"]').checked, false);
    await act(async () => document.querySelector(".redis-key").click());
    for (let attempt = 0; attempt < 30 && !globalThis.redisEditorProps; attempt++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(globalThis.redisEditorProps.document.readonly, true);
    assert.equal(button("Save").disabled, true);
    await act(async () => document.querySelector('input[type="checkbox"]').click());
    assert.equal(globalThis.redisEditorProps.document.readonly, false);
    await act(async () => globalThis.redisEditorProps.change("retained edit"));
    await act(async () => button("Save").click());
    assert.match(document.body.textContent, /Redis data changed/);
    assert.equal(globalThis.redisEditorProps.document.text, "retained edit");
    assert.equal(localStorage.length, 0, "Redis values and passwords never enter local storage");
    await act(async () => view.root.render(React.createElement(view.RedisWorkspace, props(false))));
    assert.equal(document.querySelector(".redis-workspace").hidden, true);
    await act(async () => view.root.render(React.createElement(view.RedisWorkspace, props(true))));
    assert.equal(globalThis.redisEditorProps.document.text, "retained edit");
    await act(async () => button("Disconnect").click());
    const dialog = document.querySelector("dialog[open]");
    assert.ok(dialog);
    assert.equal(calls.filter((call) => call.command === "redis_disconnect").length, 0);
    await act(async () => button("Cancel", dialog).click());
    conflict = false;
    await act(async () => button("Save").click());
    const save = calls.find(
      (call) => call.command === "redis_request" && call.args.request.op === "save",
    );
    assert.equal(save.args.request.db, 0);
    assert.equal(save.args.request.expected, "a".repeat(64));
    assert.equal(save.args.request.value, Buffer.from("retained edit").toString("base64"));
    assert.equal(button("Save").disabled, true);
    binaryStage = true;
    await act(async () => button("Reconnect").click());
    assert.equal(
      calls.find((call) => call.command === "redis_reconnect").args.handle,
      "connection",
    );
    assert.equal(document.querySelector('input[type="checkbox"]').checked, false);
    await act(async () => document.querySelector('input[type="checkbox"]').click());
    await act(async () => document.querySelector('button[title="00 ff"]').click());
    await act(async () => button("Add field").click());
    await act(async () => button("Create").click());
    await act(async () => button("Save").click());
    const binaryWrite = calls
      .filter((call) => call.command === "redis_request" && call.args.request.op === "save")
      .at(-1);
    assert.equal(
      binaryWrite.args.request.key,
      binaryKey.data,
      "Adding a field retains the binary key identity",
    );
    assert.equal(binaryWrite.args.request.field, "");
    await act(async () => button("Disconnect").click());
    assert.equal(calls.filter((call) => call.command === "redis_disconnect").length, 1);
    assert.ok(button("Connect"));
  } finally {
    await view.cleanup();
  }
});
test("a Redis connection completed after unmount is immediately disconnected", async () => {
  const view = await setup();
  let resolve;
  const closed = [];
  mockIPC((command, args) => {
    if (command === "redis_connect")
      return new Promise((done) => {
        resolve = done;
      });
    if (command === "redis_disconnect") closed.push(args.handle);
    return null;
  });
  try {
    await act(async () =>
      view.root.render(
        React.createElement(view.RedisWorkspace, {
          config,
          active: true,
          password: "",
          consumed() {},
        }),
      ),
    );
    await act(async () => button("Connect").click());
    await act(async () => view.root.unmount());
    await act(async () => resolve({ handle: "late-connection", db: 0 }));
    assert.deepEqual(closed, ["late-connection"]);
  } finally {
    await view.cleanup();
  }
});
