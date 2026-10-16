import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const focus = dom.window.HTMLElement.prototype.focus;
  dom.window.HTMLElement.prototype.focus = function (...args) {
    const modal = document.querySelector("dialog[open]");
    if (!modal || modal.contains(this)) focus.apply(this, args);
  };
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

test("binary Redis values show descriptors and readable text without enabling edits or rendering markup", async () => {
  const view = await setup();
  const bytes = Buffer.concat([
    Buffer.from(
      readFileSync(new URL("./fixtures/redis-auth-info.base64", import.meta.url), "utf8").trim(),
      "base64",
    ),
    Buffer.from('<img src="x" onerror="alert(1)">'),
  ]);
  const key = { data: "YmluYXJ5", text: "binary", size: 6, truncated: false };
  const writes = [];
  mockIPC((command, args) => {
    if (command === "redis_connect") return { handle: "binary", db: 0 };
    if (command === "redis_request") {
      const op = args.request.op;
      if (op === "console")
        return { result: { text: "", data: "", size: 0, truncated: false }, elapsed: 0 };
      if (op === "scan") return { cursor: "0", entries: [{ key, kind: "string", ttl: -1 }] };
      if (op === "read")
        return {
          kind: "string",
          ttl: -1,
          db: 0,
          size: bytes.length,
          value: {
            data: bytes.toString("base64"),
            text: null,
            size: bytes.length,
            truncated: false,
          },
        };
      if (op === "save") writes.push(args.request);
    }
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
    await act(async () => document.querySelector(".redis-key").click());
    const section = document.querySelector('[aria-label="Serialization information"]');
    assert.ok(section);
    assert.match(section.textContent, /com.core.AuthInfo/);
    assert.match(section.textContent, /java.lang.String\[\]/);
    assert.match(section.textContent, /示例用户/);
    assert.match(section.querySelector("pre").textContent, /<img/);
    assert.equal(section.querySelector("img"), null);
    assert.match(document.querySelector(".redis-binary-preview pre").textContent, /^ac ed 00 05/);
    assert.equal(document.querySelector(".redis-editor"), null);
    await act(async () => document.querySelector('input[type="checkbox"]').click());
    assert.equal(document.querySelector(".redis-editor"), null);
    assert.deepEqual(writes, []);
  } finally {
    await view.cleanup();
  }
});

const blob = (text) => ({
  data: Buffer.from(text).toString("base64"),
  text,
  size: Buffer.byteLength(text),
  truncated: false,
});
async function inputValue(view, label, text) {
  const input = document.querySelector(`input[aria-label="${label}"], input[id="${label}"]`);
  assert.ok(input, `Missing input ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(view.dom.window.HTMLInputElement.prototype, "value").set.call(
      input,
      text,
    );
    input.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
  });
}
async function mountConnected(view, request) {
  mockIPC((command, args) => {
    if (command === "redis_connect") return { handle: "layout", db: 0 };
    if (command === "redis_request") {
      if (args.request.op === "console") return { result: blob(""), elapsed: 1 };
      return request(args.request);
    }
    return null;
  });
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
}
async function waitEditor() {
  for (let attempt = 0; attempt < 30 && !globalThis.redisEditorProps; attempt++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.ok(globalThis.redisEditorProps);
}

test("key refresh retains dirty values and grouping while empty scan batches remain resumable", async () => {
  const view = await setup();
  const key = blob("user:中文");
  const scans = [];
  let batches = 0;
  try {
    await mountConnected(view, (request) => {
      if (request.op === "scan") {
        scans.push(request);
        return ++batches === 1
          ? { cursor: "8", entries: [{ key, kind: "string", ttl: -1 }] }
          : batches === 2
            ? { cursor: "9", entries: [] }
            : { cursor: "0", entries: [{ key, kind: "string", ttl: -1 }] };
      }
      if (request.op === "read")
        return { kind: "string", ttl: -1, db: 0, size: 0, value: blob(""), version: "v1" };
      throw new Error(`Unexpected ${request.op}`);
    });
    await act(async () => document.querySelector(".redis-key").click());
    await waitEditor();
    await act(async () => document.querySelector('[aria-label="Allow editing"]').click());
    await act(async () => globalThis.redisEditorProps.change("草稿"));
    const group = document.querySelector(".redis-key-list details");
    await act(async () => {
      group.open = false;
      group.dispatchEvent(new view.dom.window.Event("toggle"));
    });
    await act(async () => document.querySelector('[aria-label="Refresh keys"]').click());
    assert.equal(globalThis.redisEditorProps.document.text, "草稿");
    assert.equal(document.querySelector("dialog[open]"), null);
    assert.match(
      document.querySelector(".redis-scan-status").textContent,
      /Scan incomplete.*No matches/,
    );
    assert.equal(button("Load more").disabled, false);
    await act(async () => button("Load more").click());
    assert.equal(scans.at(-1).cursor, "9");
    assert.equal(document.querySelector(".redis-key-list details").open, false);
    assert.equal(globalThis.redisEditorProps.document.text, "草稿");
    assert.match(document.querySelector(".redis-value-meta").textContent, /0 bytes/);
    assert.match(document.querySelector(".redis-scan-status").textContent, /Scan complete/);
    assert.equal(button("Load more").disabled, true);
  } finally {
    await view.cleanup();
  }
});

test("Hash keeps its batch and pattern while field switches and close honor save, discard and cancel", async () => {
  const view = await setup();
  const key = blob("用户:1");
  const fields = [blob("name"), blob("张三"), blob("profile"), blob('{"city":"上海"}')];
  const calls = [];
  let conflict = true;
  try {
    await mountConnected(view, (request) => {
      calls.push(request);
      if (request.op === "scan")
        return { cursor: "0", entries: [{ key, kind: "hash", ttl: 65000 }] };
      if (request.op === "read")
        return request.field
          ? {
              kind: "hash",
              ttl: 65000,
              db: 0,
              value: request.field === fields[0].data ? fields[1] : fields[3],
              version: "v1",
            }
          : { kind: "hash", ttl: 65000, db: 0, size: 12, items: fields, cursor: "37" };
      if (request.op === "save") {
        if (conflict) throw new Error("REDIS_CONFLICT");
        return { version: "v2" };
      }
      throw new Error(`Unexpected ${request.op}`);
    });
    await act(async () => document.querySelector(".redis-key").click());
    await inputValue(view, "Member pattern", "*");
    await act(async () => button("name").click());
    await waitEditor();
    assert.equal(document.querySelectorAll(".redis-members tbody tr").length, 2);
    assert.match(document.querySelector(".redis-value-meta").textContent, /12 members/);
    assert.match(document.querySelector(".redis-editor-actions").textContent, /6 bytes/);
    await act(async () => document.querySelector('[aria-label="Allow editing"]').click());
    await act(async () => globalThis.redisEditorProps.change("李四"));
    await act(async () => button("profile").click());
    await act(async () => button("Cancel", document.querySelector("dialog[open]")).click());
    assert.equal(globalThis.redisEditorProps.document.text, "李四");
    await act(async () => document.querySelector('[aria-label="Close field editor"]').click());
    await act(async () =>
      button("Save and continue", document.querySelector("dialog[open]")).click(),
    );
    assert.ok(document.querySelector("dialog[open]"), "Conflicts keep the guard open");
    assert.equal(globalThis.redisEditorProps.document.text, "李四");
    conflict = false;
    await act(async () =>
      button("Save and continue", document.querySelector("dialog[open]")).click(),
    );
    assert.equal(document.querySelector(".redis-editor"), null);
    assert.match(document.querySelector(".redis-members").textContent, /李四/);
    assert.equal(document.activeElement.textContent, "name");
    await act(async () => button("profile").click());
    await act(async () => globalThis.redisEditorProps.change("discard me"));
    await act(async () => button("name").click());
    await act(async () =>
      button("Discard changes", document.querySelector("dialog[open]")).click(),
    );
    assert.equal(globalThis.redisEditorProps.document.text, "张三");
    assert.equal(
      calls.filter((call) => call.op === "read" && !call.field).length,
      1,
      "Opening fields never refetches the collection batch",
    );
    await act(async () => document.querySelector('[aria-label="Close field editor"]').click());
    await act(async () => button("Next page").click());
    assert.equal(calls.at(-1).cursor, "37");
  } finally {
    await view.cleanup();
  }
});

test("action dialogs target the current key and DB, confirm once and retain failed writes", async () => {
  const view = await setup();
  const key = blob("user:1");
  const calls = [];
  let collision = true;
  try {
    await mountConnected(view, (request) => {
      calls.push(request);
      if (request.op === "scan")
        return { cursor: "0", entries: [{ key, kind: "string", ttl: 3600000 }] };
      if (request.op === "read")
        return { kind: "string", ttl: 3600000, db: 0, size: 2, value: blob("{}"), version: "v1" };
      if (request.op === "mutate" && request.action === "rename" && collision)
        throw new Error("REDIS_NAME_EXISTS");
      if (request.op === "mutate" || request.op === "select") return {};
      throw new Error(`Unexpected ${request.op}`);
    });
    await act(async () => document.querySelector(".redis-key").click());
    await act(async () => document.querySelector('[aria-label="Allow editing"]').click());
    await act(async () => button("Rename").click());
    assert.match(
      document.querySelector("dialog[open]").textContent,
      /Redis QA.*127.0.0.1:6379.*DB.*0.*user:1/s,
    );
    await inputValue(view, "New key name", "user:2");
    await act(async () => button("Confirm", document.querySelector("dialog[open]")).click());
    assert.ok(document.querySelector("dialog[open]"));
    assert.equal(document.querySelector('[aria-label="New key name"]').value, "user:2");
    assert.match(document.querySelector("dialog[open]").textContent, /destination key exists/);
    collision = false;
    await act(async () => button("Confirm", document.querySelector("dialog[open]")).click());
    assert.equal(document.querySelector("dialog[open]"), null);
    assert.deepEqual(calls.filter((call) => call.op === "mutate").at(-1), {
      op: "mutate",
      db: 0,
      key: key.data,
      action: "rename",
      argument: blob("user:2").data,
    });
    const ttlEntry = button("TTL · 1 h");
    await act(async () => ttlEntry.click());
    await act(async () => button("Cancel", document.querySelector("dialog[open]")).click());
    assert.equal(document.activeElement, ttlEntry, "Focus returns after the native modal closes");
    await act(async () => button("TTL · 1 h").click());
    await inputValue(view, "TTL (seconds)", "90");
    await act(async () => button("Confirm", document.querySelector("dialog[open]")).click());
    assert.equal(calls.filter((call) => call.op === "mutate").at(-1).argument, "90");
    await act(async () => button("TTL · 1 h").click());
    await act(async () => button("Clear TTL", document.querySelector("dialog[open]")).click());
    assert.equal(calls.filter((call) => call.op === "mutate").at(-1).action, "persist");
    await act(async () => button("Delete key").click());
    await act(async () => button("Confirm", document.querySelector("dialog[open]")).click());
    assert.equal(document.querySelector(".redis-value-heading"), null);
    assert.equal(
      calls.filter((call) => call.op === "mutate" && call.action === "delete").length,
      1,
    );
    await act(async () => button("Database DB 0 ▾").click());
    await inputValue(view, "Database DB", "3");
    await act(async () => button("Switch", document.querySelector("dialog[open]")).click());
    assert.ok(button("Database DB 3 ▾"));
    assert.ok(calls.some((call) => call.op === "select" && call.db === 3));
  } finally {
    await view.cleanup();
  }
});

test("narrow key drawer traps focus and restores it on Escape; resizer supports keyboard input", async () => {
  const view = await setup();
  let observe;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      observe = callback;
    }
    observe() {
      observe([{ contentRect: { width: 600 } }]);
    }
    disconnect() {}
  };
  try {
    await mountConnected(view, (request) => {
      if (request.op === "scan") return { cursor: "0", entries: [] };
    });
    const toggle = document.querySelector('[aria-label="Browse keys"][aria-expanded]');
    await act(async () => toggle.click());
    assert.equal(document.activeElement, document.querySelector(".redis-search input"));
    const first = document.activeElement;
    await act(async () =>
      first.dispatchEvent(
        new view.dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      ),
    );
    assert.equal(document.activeElement.getAttribute("aria-label"), "Close key browser");
    await act(async () =>
      document.activeElement.dispatchEvent(
        new view.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      ),
    );
    assert.equal(document.activeElement, first);
    await act(async () =>
      first.dispatchEvent(
        new view.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, toggle);
    await act(async () => observe([{ contentRect: { width: 1000 } }]));
    const separator = document.querySelector('[role="separator"]');
    await act(async () =>
      separator.dispatchEvent(
        new view.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    assert.equal(separator.getAttribute("aria-valuenow"), "290");
    await act(async () =>
      separator.dispatchEvent(
        new view.dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      ),
    );
    assert.equal(separator.getAttribute("aria-valuenow"), "180");
  } finally {
    await view.cleanup();
    delete globalThis.ResizeObserver;
  }
});

test("collection tables use type-specific columns and large and binary values stay bounded previews", async () => {
  const view = await setup();
  const kinds = ["list", "set", "zset", "hash", "string"];
  const calls = [];
  try {
    await mountConnected(view, (request) => {
      calls.push(request);
      if (request.op === "scan")
        return { cursor: "0", entries: kinds.map((kind) => ({ key: blob(kind), kind, ttl: -1 })) };
      if (request.op === "read") {
        const kind = Buffer.from(request.key, "base64").toString();
        if (kind === "string")
          return {
            kind,
            ttl: -1,
            db: 0,
            size: 1048580,
            value: { ...blob("preview"), truncated: true },
            version: null,
          };
        if (kind === "hash" && request.field)
          return {
            kind,
            ttl: -1,
            db: 0,
            value: { data: "AP8=", text: null, size: 2, truncated: false },
            version: "v1",
          };
        return {
          kind,
          ttl: -1,
          db: 0,
          size: kind === "list" ? 201 : 1,
          items:
            kind === "zset"
              ? [blob("alice"), blob("90")]
              : kind === "hash"
                ? [blob("binary"), blob("preview")]
                : [blob("成员")],
          cursor: "0",
        };
      }
    });
    for (const kind of kinds) {
      await act(async () => document.querySelector(`.redis-key[title="${kind}"]`).click());
      if (kind === "list") {
        assert.match(document.querySelector("thead").textContent, /Index.*Value preview/);
        await act(async () => button("Next page").click());
        assert.equal(calls.at(-1).offset, 200);
        assert.match(document.querySelector(".redis-pagination").textContent, /201–201 \/ 201/);
        await act(async () => button("Previous page").click());
        assert.equal(calls.at(-1).offset, 0);
      } else if (kind === "set") {
        assert.equal(document.querySelectorAll("thead th").length, 1);
        assert.match(document.querySelector("thead").textContent, /Member/);
      } else if (kind === "zset") {
        assert.match(document.querySelector("thead").textContent, /Member.*Score/);
        assert.match(document.querySelector("tbody").textContent, /alice90/);
      } else if (kind === "hash") {
        await act(async () => button("binary").click());
        assert.equal(document.querySelectorAll("tbody tr").length, 1);
        assert.match(document.querySelector(".redis-binary-preview pre").textContent, /^00 ff/);
        assert.match(document.querySelector(".redis-editor-actions").textContent, /2 bytes/);
        assert.equal(document.querySelector(".redis-editor"), null);
        await act(async () => document.querySelector('[aria-label="Close field editor"]').click());
      } else {
        assert.equal(document.querySelector(".redis-editor"), null);
        assert.match(document.querySelector(".redis-value-preview").textContent, /exceeds 1 MB/);
        await act(async () => button("Next page").click());
        assert.equal(calls.at(-1).offset, 1048576);
        assert.match(document.querySelector(".redis-pagination").textContent, /1048577–1048580/);
      }
    }
    assert.ok(calls.every((call) => call.op !== "save"));
  } finally {
    await view.cleanup();
  }
});

test("creating Hash data reads authoritative size and TTL without dropping the saved field", async () => {
  const view = await setup();
  const calls = [];
  try {
    await mountConnected(view, (request) => {
      calls.push(request);
      if (request.op === "scan") return { cursor: "0", entries: [] };
      if (request.op === "save") return { version: "created" };
      if (request.op === "read")
        return {
          kind: "hash",
          db: 0,
          ttl: 120000,
          size: 5,
          items: [blob("new"), blob("")],
          cursor: "0",
        };
    });
    await act(async () => document.querySelector('[aria-label="Allow editing"]').click());
    await act(async () => document.querySelector('[aria-label="New key"]').click());
    await inputValue(view, "New key", "user:existing");
    const type = document.querySelector('[aria-label="Value type"]');
    await act(async () => {
      type.value = "hash";
      type.dispatchEvent(new view.dom.window.Event("change", { bubbles: true }));
    });
    await inputValue(view, "Hash field", "new");
    await act(async () => button("Create", document.querySelector("dialog[open]")).click());
    await waitEditor();
    assert.match(document.querySelector(".redis-value-meta").textContent, /—/);
    await act(async () => button("Save").click());
    assert.equal(calls.find((call) => call.op === "save").field, blob("new").data);
    assert.match(document.querySelector(".redis-value-meta").textContent, /5 members.*2 min/);
    assert.equal(globalThis.redisEditorProps.document.text, "");
    assert.equal(button("Save").disabled, true);
    assert.match(document.querySelector(".redis-key").textContent, /2 min/);
    assert.equal(localStorage.length, 0);
  } finally {
    await view.cleanup();
  }
});
