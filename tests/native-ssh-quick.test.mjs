import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";

test("native Quick SSH uses the shared form with a fixed workspace and retains its address on language refresh", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
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
  const server = await createServer({ configFile: false });
  const { NativeSshQuick } = await server.ssrLoadModule("/src/native-ssh-quick.tsx");
  const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
  const { defaults } = await server.ssrLoadModule("/src/lib/settings.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  let settings = { ...defaults, language: "en" };
  let ready = false;
  let malformed = true;
  let succeeds = false;
  let failClose = true;
  const calls = [];
  window.utermContentDocument = "quick-test";
  window.webkit = {
    messageHandlers: {
      utermContent: {
        async postMessage(message) {
          calls.push(message);
          let result = null;
          let error;
          if (message.method === "quick_ssh_context") {
            if (!ready) error = { code: "READ_FAILED", message: "Connection context failed" };
            else result = { workspaceId: malformed ? "" : "captured" };
          } else if (message.method === "quick_ssh_connect") {
            assert.equal(message.params.connection.workspace_id, "captured");
            assert.equal(message.params.connection.host, "::1");
            assert.equal(message.params.connection.port, 2222);
            assert.equal(message.params.connection.authentication, "config");
            assert.ok(message.params.connection.connection_id);
            if (!succeeds)
              error = { code: "CONFLICT", message: "Another client switched workspace" };
            else result = true;
          } else {
            assert.equal(message.method, "quick_ssh_close");
            if (failClose) error = { code: "SSH_OPERATION_BUSY", message: "Still saving" };
          }
          return {
            version: 1,
            document: message.document,
            id: message.id,
            ...(error ? { error } : { result }),
          };
        },
      },
    },
  };
  const submit = async () =>
    act(async () =>
      document
        .querySelector("form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
  try {
    await act(async () =>
      root.render(
        React.createElement(
          SettingsProvider,
          {
            content: {
              settings,
              read: async () => settings,
              update: async () => assert.fail("Unexpected settings write"),
              adjust: async () => assert.fail("Unexpected font write"),
            },
          },
          React.createElement(NativeSshQuick),
        ),
      ),
    );
    assert.match(document.querySelector('[role="alert"]').textContent, /context failed/);
    assert.ok(document.querySelector(".ssh-quick-dialog[open]"));
    ready = true;
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent.trim() === "Retry")
        .click(),
    );
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /Invalid Quick SSH workspace/,
    );
    assert.equal(document.querySelector("input"), null);
    malformed = false;
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent.trim() === "Retry")
        .click(),
    );
    assert.ok(document.querySelector(".ssh-quick-dialog[open]"));
    await act(async () => {
      const field = document.querySelector("input");
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
        field,
        "dev@[::1]:2222",
      );
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    settings = { ...settings, language: "zh-Hans" };
    await act(async () =>
      window.dispatchEvent(
        new window.CustomEvent("uterm-content-event", {
          detail: {
            version: 1,
            document: "quick-test",
            kind: "quick-ssh-settings-changed",
            payload: null,
          },
        }),
      ),
    );
    assert.equal(document.querySelector("h2").textContent, "快速 SSH 连接");
    assert.equal(document.querySelector("input").value, "dev@[::1]:2222");
    await submit();
    assert.ok(document.querySelector('[role="alert"]'));
    assert.equal(calls.filter((call) => call.method === "quick_ssh_close").length, 0);
    succeeds = true;
    await submit();
    assert.equal(calls.filter((call) => call.method === "quick_ssh_connect").length, 2);
    assert.equal(calls.filter((call) => call.method === "quick_ssh_close").length, 1);
    assert.match(document.querySelector('form [role="alert"]').textContent, /Still saving/);
    failClose = false;
    await act(async () => document.querySelector('button[type="button"]').click());
    assert.equal(calls.filter((call) => call.method === "quick_ssh_close").length, 2);
    assert.equal(calls.filter((call) => call.method === "quick_ssh_context").length, 3);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
