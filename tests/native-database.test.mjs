import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";
import React, { act } from "react";

test("native database profile conflicts retain input and quit/resume keeps a modal draft protected", async () => {
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
  window.utermContentDocument = "native-database-unit";
  const config = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "PostgreSQL QA",
    kind: "postgresql",
    host: "127.0.0.1",
    port: 5432,
    database: "qa",
    username: "qa",
    tls: false,
    ca_file: "",
    credential_id: null,
  };
  const catalog = {
    revision: "first",
    selectedWorkspace: "qa",
    groups: [{ id: "qa", name: "QA", databaseConnections: [config], sshConnections: [] }],
  };
  const calls = [];
  let busyWrite = false;
  window.webkit = {
    messageHandlers: {
      utermContent: {
        async postMessage(message) {
          calls.push(message);
          let result = null;
          if (message.method === "database_profiles") result = structuredClone(catalog);
          if (message.method === "database_components")
            result = { java: "/qa/java", items: [], busy: false };
          if (message.method === "database_profile_save") {
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
            catalog.groups[0].databaseConnections = [structuredClone(message.params.config)];
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
        name: "native-database-unit-editor",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/FileEditor")) return "\0native-database-unit-editor";
        },
        load(id) {
          if (id === "\0native-database-unit-editor")
            return "export function CodeEditor() { return null; }";
        },
      },
    ],
  });
  const { NativeDatabase } = await server.ssrLoadModule("/src/native-database.tsx");
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
  try {
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
          React.createElement(NativeDatabase),
        ),
      ),
    );
    await act(async () =>
      document.querySelector('[aria-label="Edit database connection: PostgreSQL QA"]').click(),
    );
    assert.equal(
      calls.filter((call) => call.method === "database_components").length,
      0,
      "Opening the profile editor must not start an unseen component probe that blocks saving",
    );
    catalog.selection = { request: "sidebar-click", group: "qa", id: config.id };
    await act(async () =>
      window.dispatchEvent(
        new window.CustomEvent("uterm-content-event", {
          detail: {
            version: 1,
            document: "native-database-unit",
            kind: "database-selection-changed",
            payload: null,
          },
        }),
      ),
    );
    assert.ok(
      document.querySelector("dialog[open]"),
      "Selecting a connection must preserve the open profile draft",
    );
    assert.equal(
      document.querySelector(".native-database-profile-name[aria-pressed=true]")?.textContent,
      config.name,
    );
    assert.equal(document.querySelector(".native-database-toolbar").hidden, true);
    assert.equal(document.querySelector(".native-database-layout > aside").hidden, true);
    const retainedWorkbench = document.querySelector(".database-workspace");
    await act(async () => document.querySelector(".native-workbench-connections").click());
    assert.equal(document.querySelector(".native-database-toolbar").hidden, false);
    assert.equal(document.querySelector(".native-database-layout > aside").hidden, false);
    assert.equal(document.querySelector(".database-workspace"), retainedWorkbench);
    assert.ok(document.querySelector("dialog[open]"), "Navigation must retain the profile draft");
    await act(async () => document.querySelector(".native-workbench-back").click());
    assert.equal(document.querySelector(".native-database-layout > aside").hidden, true);
    assert.equal(document.querySelector(".database-workspace"), retainedWorkbench);
    await act(async () => document.querySelector(".native-workbench-connections").click());
    await act(async () =>
      document.querySelector(".native-database-profile-name[aria-pressed=true]").click(),
    );
    assert.equal(document.querySelector(".native-database-layout > aside").hidden, true);
    assert.equal(document.querySelector(".database-workspace"), retainedWorkbench);
    assert.ok(
      document.querySelector("dialog[open]"),
      "Connection navigation must retain an unrelated modal draft",
    );
    const name = document.querySelector("dialog[open] input");
    await change(name, "Retained draft 中文");
    await change(input("Password"), "PRIVATE_TEMPORARY_PASSWORD");
    catalog.revision = "concurrent";
    await act(async () =>
      document
        .querySelector("dialog[open] form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(document.querySelector("dialog[open] input").value, "Retained draft 中文");
    assert.equal(input("Password").value, "PRIVATE_TEMPORARY_PASSWORD");
    assert.equal(catalog.groups[0].databaseConnections[0].name, "PostgreSQL QA");
    assert.ok(
      calls
        .filter((call) => call.method === "database_profile_save")
        .every((call) => !JSON.stringify(call.params).includes("PRIVATE_TEMPORARY_PASSWORD")),
    );
    assert.match(document.querySelector('[role="alert"]').textContent, /another window/i);
    const signal = (value) =>
      window.dispatchEvent(
        new window.CustomEvent("uterm-content-event", {
          detail: {
            version: 1,
            document: "native-database-unit",
            kind: "database-frozen",
            payload: value,
          },
        }),
      );
    await act(async () => signal(true));
    assert.equal(document.querySelector("dialog[open]").inert, true);
    await act(async () => signal(false));
    assert.notEqual(document.querySelector("dialog[open]").inert, true);
    assert.equal(input("Password").value, "PRIVATE_TEMPORARY_PASSWORD");
    assert.equal(
      calls
        .filter(
          (call) =>
            call.method === "database_guard" &&
            call.params.id === calls.find((call) => call.method === "database_guard").params.id,
        )
        .at(-1).params.dirty,
      true,
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
    assert.equal(catalog.groups[0].databaseConnections[0].name, "Retained draft 中文");
    assert.ok(!JSON.stringify(catalog).includes("PRIVATE_TEMPORARY_PASSWORD"));
    await act(async () => button("Retained draft 中文").click());
    assert.equal(
      document.querySelector('[aria-label="Temporary password"]').value,
      "PRIVATE_TEMPORARY_PASSWORD",
    );
    await act(async () =>
      document
        .querySelector('[aria-label="Edit database connection: Retained draft 中文"]')
        .click(),
    );
    await change(input("Host address"), "127.0.0.2");
    await act(async () =>
      document
        .querySelector("dialog[open] form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(catalog.groups[0].databaseConnections[0].host, "127.0.0.2");
    assert.equal(document.querySelector('[aria-label="Temporary password"]').value, "");
    await act(async () => button("Database components").click());
    assert.equal(calls.filter((call) => call.method === "database_components").length, 1);
    await act(async () => button("Database components").click());
    await act(async () => button("Database components").click());
    assert.equal(
      calls.filter((call) => call.method === "database_components").length,
      1,
      "Reopening the component manager must retain its mounted state",
    );
  } finally {
    await act(async () => root.unmount());
    window.dispatchEvent(new window.Event("pagehide"));
    await server.close();
    dom.window.close();
  }
});
