import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";

test("native GitHub tools scope navigation failures and retain the PR draft across settings", async () => {
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
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const server = await createServer({ configFile: false });
  const { NativeGitHub } = await server.ssrLoadModule("/src/native-github.tsx");
  const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
  const { defaults } = await server.ssrLoadModule("/src/lib/settings.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  let settings = { ...defaults, language: "en" };
  let refuseToolbar = true;
  const calls = [];
  window.utermContentDocument = "github-test";
  const event = (kind) =>
    window.dispatchEvent(
      new window.CustomEvent("uterm-content-event", {
        detail: { version: 1, document: "github-test", kind, payload: null },
      }),
    );
  window.webkit = {
    messageHandlers: {
      utermContent: {
        async postMessage(message) {
          assert.equal(message.document, "github-test");
          calls.push(message);
          const { method, params } = message;
          let result = null;
          if (method === "github_context") result = { canAssociate: true, canInsert: false };
          else if (method === "github_repositories") {
            assert.equal(params.directory, "/fixture");
            result = ["fixture-owner/fixture-repo"];
          } else if (method === "github_read") result = [];
          else if (method === "github_prepare_pr")
            result = {
              title: "Retain 中文",
              branch: "qa-feature",
              base: "main",
              head: "qa-feature",
            };
          else if (method === "github_form_guard") assert.equal(params.active, true);
          else if (method === "github_toolbar") {
            assert.deepEqual(params, { kind: "files" });
            if (refuseToolbar)
              return {
                version: 1,
                id: message.id,
                document: message.document,
                error: { code: "CONFLICT", message: "Project selection changed" },
              };
          } else assert.fail(method);
          return { version: 1, id: message.id, document: message.document, result };
        },
      },
    },
  };
  const settle = async () => act(async () => new Promise((done) => setTimeout(done, 350)));
  const click = async (text) =>
    act(async () => {
      const button = [...document.querySelectorAll("button")].find(
        (button) => button.textContent.trim() === text,
      );
      assert.ok(button, text);
      button.click();
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
              update: async () => assert.fail("Unexpected settings write"),
              adjust: async () => assert.fail("Unexpected font write"),
            },
          },
          React.createElement(NativeGitHub, { directory: "/fixture" }),
        ),
      ),
    );
    await settle();
    assert.equal(document.querySelectorAll(".inspector-switcher button").length, 4);
    assert.equal(
      document
        .querySelector('.inspector-switcher [aria-pressed="true"]')
        .getAttribute("aria-label"),
      "GitHub",
    );
    await act(async () =>
      document.querySelector('.inspector-switcher [aria-label="Files"]').click(),
    );
    assert.match(document.querySelector('[role="alert"]').textContent, /selection changed/);
    refuseToolbar = false;
    await act(async () =>
      document.querySelector('.inspector-switcher [aria-label="Files"]').click(),
    );
    assert.equal(calls.filter((call) => call.method === "github_toolbar").length, 2);
    assert.equal(document.querySelector('[role="alert"]'), null);
    await click("Pull Requests");
    await settle();
    await click("New PR");
    const input = document.querySelector("dialog input");
    assert.equal(input.value, "Retain 中文");
    settings = { ...settings, language: "zh-Hans", appearance: "light" };
    await act(async () => event("github-settings-changed"));
    assert.equal(document.querySelector("dialog input"), input);
    assert.equal(input.value, "Retain 中文");
    assert.ok(document.querySelector("dialog").open);
    assert.equal(
      document
        .querySelector('.inspector-switcher [aria-label="文件"]')
        .getAttribute("aria-pressed"),
      "false",
    );
    assert.ok(!calls.some((call) => call.method === "github_create_pr"));
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
    for (const key of [
      "window",
      "document",
      "navigator",
      "HTMLElement",
      "Node",
      "localStorage",
      "matchMedia",
      "IS_REACT_ACT_ENVIRONMENT",
    ])
      delete globalThis[key];
  }
});
