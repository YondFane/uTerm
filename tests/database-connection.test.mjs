import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Elasticsearch dialog normalizes addresses before tests and credential saves with specific errors", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { DatabaseConnectionDialog } = await server.ssrLoadModule(
    "/src/components/DatabaseConnectionDialog.tsx",
  );
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  const saved = [];
  const config = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "",
    kind: "elasticsearch",
    host: "127.0.0.1",
    port: 9200,
    database: "",
    username: "elastic",
    tls: false,
    ca_file: "",
    credential_id: null,
  };
  const credential = "22222222-2222-4222-8222-222222222222";
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "database_connect") return { handle: "qa" };
    if (command === "database_disconnect") return null;
    if (command === "database_credential") return credential;
    assert.fail(command);
  });
  const inputFor = (label) =>
    [...document.querySelectorAll("label")]
      .find((item) => item.textContent === label)
      ?.querySelector("input");
  const setInput = async (input, value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
        input,
        value,
      );
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const button = (label) =>
    [...document.querySelectorAll("button")].find((item) => item.textContent === label);
  const render = async (language, patch = {}) =>
    act(async () => {
      setUiLanguage(language);
      root.render(
        React.createElement(DatabaseConnectionDialog, {
          key: `${language}:${JSON.stringify(patch)}`,
          connection: { ...config, ...patch },
          ssh: [],
          workspaceId: "qa",
          save(next, password) {
            saved.push({ next, password });
            return true;
          },
          close() {},
          report() {},
        }),
      );
    });
  try {
    for (const language of ["zh-Hans", "en"]) {
      const labels =
        language === "en"
          ? {
              host: "Host address",
              port: "Port",
              tls: "Enable TLS",
              test: "Test connection",
              password: "Password",
              remember: "Remember password (system credential store)",
            }
          : {
              host: "主机地址",
              port: "端口",
              tls: "启用 TLS",
              test: "测试连接",
              password: "密码",
              remember: "记住密码（系统凭据库）",
            };
      await render(language);
      const host = inputFor(labels.host);
      await setInput(host, "https://es.example.com");
      await act(async () =>
        host.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })),
      );
      assert.equal(host.value, "es.example.com");
      assert.equal(inputFor(labels.port).value, "443");
      assert.equal(inputFor(labels.tls).checked, true);
      await setInput(inputFor(labels.port), "9243");
      await act(async () => button(labels.test).click());
      const connect = calls.findLast((call) => call.command === "database_connect");
      assert.deepEqual(connect.args.config, {
        ...config,
        name: "Elasticsearch es.example.com:9243",
        host: "es.example.com",
        port: 9243,
        tls: true,
      });
      assert.equal(calls.at(-1).command, "database_disconnect");

      await setInput(host, "https://user:secret@es.example.com");
      const count = calls.length;
      await act(async () => button(labels.test).click());
      assert.equal(calls.length, count);
      assert.match(document.querySelector('[role="alert"]').textContent, /HTTP\/HTTPS/);
      assert.doesNotMatch(document.querySelector('[role="alert"]').textContent, /secret/);
      await setInput(host, "es.example.com");
      await setInput(inputFor(labels.port), "0");
      await act(async () => button(labels.test).click());
      assert.match(document.querySelector('[role="alert"]').textContent, /65535/);
      assert.equal(calls.length, count);

      await setInput(host, "http://127.0.0.1:9200/");
      await setInput(inputFor(labels.password), "fixture-password");
      await act(async () => inputFor(labels.remember).click());
      await act(async () =>
        document
          .querySelector("form")
          .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
      );
      const stored = calls.at(-1);
      assert.equal(stored.command, "database_credential");
      assert.equal(stored.args.config.host, "127.0.0.1");
      assert.equal(stored.args.config.port, 9200);
      assert.equal(stored.args.config.tls, false);
      assert.equal(saved.at(-1).next.credential_id, credential);
      assert.equal(saved.at(-1).password, "");
      assert.equal(saved.at(-1).next.name, "Elasticsearch 127.0.0.1:9200");
    }
    await render("en", { kind: "mysql", port: 3306, host: "https://sql.example.com" });
    const count = calls.length;
    await act(async () => button("Test connection").click());
    assert.equal(calls.length, count);
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /Invalid database connection/,
    );
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
