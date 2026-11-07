import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";
import React, { act } from "react";

test("native Redis profile conflicts retain input and quit/resume keeps a modal draft protected", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage"])
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
  window.utermContentDocument = "native-redis-unit";
  const config = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Redis QA",
    host: "127.0.0.1",
    port: 6379,
    db: 0,
    username: "qa",
    tls: false,
    ca_file: "",
    server_name: "",
    ssh_host: "",
    credential_id: null,
  };
  const catalog = {
    revision: "first",
    selectedWorkspace: "qa",
    groups: [{ id: "qa", name: "QA", redisConnections: [config], sshConnections: [] }],
  };
  const calls = [];
  let busyWrite = false;
  window.webkit = {
    messageHandlers: {
      utermContent: {
        async postMessage(message) {
          calls.push(message);
          let result = null;
          if (message.method === "redis_profiles") result = structuredClone(catalog);
          if (message.method === "redis_components")
            result = { java: "/qa/java", items: [], busy: false };
          if (message.method === "redis_profile_save") {
            if (busyWrite) {
              busyWrite = false;
              return {
                version: 1,
                document: message.document,
                id: message.id,
                error: { code: "WRITER_BUSY", message: "Another canonical writer owns the store" },
              };
            }
            if (message.params.expectedRevision !== catalog.revision)
              return {
                version: 1,
                document: message.document,
                id: message.id,
                error: { code: "CONFLICT", message: "Snapshot revision changed" },
              };
            catalog.groups[0].redisConnections = [
              Object.fromEntries(Object.entries(message.params.config).reverse()),
            ];
            catalog.revision = "saved";
            result = structuredClone(catalog);
          }
          return { version: 1, document: message.document, id: message.id, result };
        },
      },
    },
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    plugins: [
      {
        name: "native-redis-unit-editor",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/FileEditor")) return "\0native-redis-unit-editor";
        },
        load(id) {
          if (id === "\0native-redis-unit-editor")
            return "export function CodeEditor() { return null; }";
        },
      },
    ],
  });
  const { NativeRedis } = await server.ssrLoadModule("/src/native-redis.tsx");
  const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
  const { defaults } = await server.ssrLoadModule("/src/lib/settings.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const settings = { ...defaults, language: "en" };
  const button = (title) =>
    [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === title);
  const input = (label) =>
    [...document.querySelectorAll("label")]
      .find((item) => item.textContent.trim() === label)
      ?.querySelector("input");
  const change = async (element, value) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
        element,
        value,
      );
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  const originalRandomUUID = crypto.randomUUID;
  try {
    crypto.randomUUID = undefined;
    await act(async () =>
      root.render(
        React.createElement(
          SettingsProvider,
          {
            content: {
              settings,
              read: async () => settings,
              update: async () => settings,
              adjust: async () => settings,
            },
          },
          React.createElement(NativeRedis),
        ),
      ),
    );
    await act(async () =>
      document.querySelector('[aria-label="Edit Redis connection: Redis QA"]').click(),
    );
    const name = document.querySelector("dialog[open] input");
    await change(name, "Retained draft 中文");
    await change(input("Password (optional)"), "PRIVATE_TEMPORARY_PASSWORD");
    catalog.revision = "concurrent";
    await act(async () =>
      document
        .querySelector("dialog[open] form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(document.querySelector("dialog[open] input").value, "Retained draft 中文");
    assert.equal(input("Password (optional)").value, "PRIVATE_TEMPORARY_PASSWORD");
    assert.equal(catalog.groups[0].redisConnections[0].name, "Redis QA");
    assert.ok(
      calls
        .filter((call) => call.method === "redis_profile_save")
        .every((call) => !JSON.stringify(call.params).includes("PRIVATE_TEMPORARY_PASSWORD")),
    );
    assert.match(document.querySelector('[role="alert"]').textContent, /another window/i);
    const signal = (value) =>
      window.dispatchEvent(
        new window.CustomEvent("uterm-content-event", {
          detail: {
            version: 1,
            document: "native-redis-unit",
            kind: "redis-frozen",
            payload: value,
          },
        }),
      );
    await act(async () => signal(true));
    assert.equal(document.querySelector("dialog[open]").inert, true);
    await act(async () => signal(false));
    assert.notEqual(document.querySelector("dialog[open]").inert, true);
    assert.equal(input("Password (optional)").value, "PRIVATE_TEMPORARY_PASSWORD");
    assert.equal(calls.filter((call) => call.method === "redis_guard").at(-1).params.active, true);
    assert.match(
      calls.find((call) => call.method === "redis_guard").params.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    await act(async () => button("Reload").click());
    busyWrite = true;
    await act(async () =>
      document
        .querySelector("dialog[open] form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.ok(document.querySelector("dialog[open]"));
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /saving the configuration.*retry/i,
    );
    await act(async () =>
      document
        .querySelector("dialog[open] form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(document.querySelector("dialog[open]"), null);
    assert.equal(catalog.groups[0].redisConnections[0].name, "Retained draft 中文");
    assert.ok(!JSON.stringify(catalog).includes("PRIVATE_TEMPORARY_PASSWORD"));
    await act(async () => button("Retained draft 中文").click());
    assert.equal(
      document.querySelector('input[type="password"]').value,
      "PRIVATE_TEMPORARY_PASSWORD",
    );
    await act(async () =>
      document.querySelector('[aria-label="Edit Redis connection: Retained draft 中文"]').click(),
    );
    await change(input("Redis host"), "127.0.0.2");
    await act(async () =>
      document
        .querySelector("dialog[open] form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(catalog.groups[0].redisConnections[0].host, "127.0.0.2");
    assert.equal(document.querySelector('input[type="password"]').value, "");
  } finally {
    crypto.randomUUID = originalRandomUUID;
    await act(async () => root.unmount());
    window.dispatchEvent(new window.Event("pagehide"));
    await server.close();
    dom.window.close();
  }
});
