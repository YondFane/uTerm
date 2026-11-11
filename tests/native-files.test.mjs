import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";

test("native file tools use scoped WebKit controls, retain the query and react to settings and quit", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  const server = await createServer({ configFile: false });
  const { NativeFiles } = await server.ssrLoadModule("/src/native-files.tsx");
  const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
  const { defaults } = await server.ssrLoadModule("/src/lib/settings.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  let context = {
    mode: "tree",
    request: 0,
    clipboard: { directory: "/other", path: "copied.txt" },
  };
  let settings = { ...defaults, language: "en" };
  let failCopy = false;
  let delayContext = false;
  let finishContext;
  const event = (kind, payload = null) =>
    window.dispatchEvent(
      new window.CustomEvent("uterm-content-event", {
        detail: { version: 1, document: "files-test", kind, payload },
      }),
    );
  window.utermContentDocument = "files-test";
  window.webkit = {
    messageHandlers: {
      utermContent: {
        async postMessage(message) {
          assert.equal(message.document, "files-test");
          assert.equal(message.kind, "request");
          calls.push(message);
          const { method, params } = message;
          let result = null;
          if (method === "files_context") {
            result = { ...context };
            if (delayContext) {
              delayContext = false;
              await new Promise((resolve) => {
                finishContext = resolve;
              });
            }
          } else if (method === "files_clipboard") {
            if (failCopy)
              return {
                version: 1,
                id: message.id,
                document: message.document,
                error: { code: "ROOT_DENIED", message: "Copy source changed" },
              };
            context = { ...context, clipboard: params.value };
          } else if (method === "files_mode") {
            context = { ...context, mode: params.mode, request: context.request + 1 };
            event("files-mode-changed");
          } else if (method === "files_list") {
            assert.equal(params.directory, "/fixture");
            assert.equal(params.hidden, true);
            result = {
              entries: [{ path: "note.txt", name: "note.txt", directory: false, symlink: false }],
              partial: false,
              skipped: 0,
            };
          } else if (method === "files_search") {
            assert.equal(params.directory, "/fixture");
            result = {
              matches: params.query
                ? [{ path: "note.txt", line: params.content ? 2 : 0, text: "MATCH_中文" }]
                : [],
              partial: false,
              skipped: 0,
            };
          } else if (method === "files_toolbar" && params.kind === "git") {
            return {
              version: 1,
              id: message.id,
              document: message.document,
              error: { code: "GIT_ERROR", message: "Repository unavailable" },
            };
          } else
            assert.ok(["git_file_status", "files_toolbar", "content_open_file"].includes(method));
          return { version: 1, id: message.id, document: message.document, result };
        },
      },
    },
  };
  const click = async (selector) => {
    const button = document.querySelector(selector);
    assert.ok(button, selector);
    await act(async () => button.click());
  };
  try {
    await act(async () => {
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
          React.createElement(NativeFiles, { directory: "/fixture" }),
        ),
      );
    });
    assert.equal(document.querySelectorAll(".inspector-tabs [role=tab]").length, 3);
    assert.equal(document.querySelectorAll(".inspector-switcher button").length, 4);
    const copy = async () => {
      await act(async () =>
        document.querySelector('.file-row[data-path="note.txt"]').dispatchEvent(
          new window.MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 40,
            clientY: 100,
          }),
        ),
      );
      const items = [...document.querySelectorAll('[role="menuitem"]')];
      assert.equal(items.find((button) => button.textContent.trim() === "Paste").disabled, false);
      await act(async () => items.find((button) => button.textContent.trim() === "Copy").click());
    };
    await copy();
    assert.deepEqual(calls.findLast((call) => call.method === "files_clipboard").params, {
      value: { directory: "/fixture", path: "note.txt" },
    });
    failCopy = true;
    await copy();
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /Copy failed.*source changed/,
    );
    await click('.inspector-switcher button[aria-label="Files"]');
    failCopy = false;
    await click('.file-row[data-path="note.txt"]');
    assert.deepEqual(calls.findLast((call) => call.method === "content_open_file").params, {
      path: "note.txt",
      line: 0,
    });
    context = { ...context, mode: "quick", request: context.request + 1 };
    delayContext = true;
    await act(async () => event("files-mode-changed"));
    assert.equal(typeof finishContext, "function");
    context = { ...context, mode: "search", request: context.request + 1 };
    await act(async () => event("files-mode-changed"));
    assert.equal(
      document
        .querySelector('[role=tab][aria-label="Project search"]')
        .getAttribute("aria-selected"),
      "true",
    );
    await act(async () => finishContext());
    assert.equal(
      document
        .querySelector('[role=tab][aria-label="Project search"]')
        .getAttribute("aria-selected"),
      "true",
    );
    await click('[role=tab][aria-label="Project search"]');
    const query = document.querySelector(".file-query");
    assert.ok(
      query,
      JSON.stringify({
        context,
        body: document.body.textContent,
        calls: calls.map((call) => call.method),
      }),
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
        query,
        "MATCH_中文",
      );
      query.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => new Promise((done) => setTimeout(done, 300)));
    assert.equal(document.querySelectorAll(".file-hit").length, 1);
    await act(async () =>
      query.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    assert.deepEqual(calls.findLast((call) => call.method === "content_open_file").params, {
      path: "note.txt",
      line: 2,
    });
    await click('.inspector-switcher button[aria-label="Git"]');
    assert.match(document.querySelector('[role="alert"]').textContent, /Repository unavailable/);
    await click('.inspector-switcher button[aria-label="Files"]');
    assert.equal(document.querySelector('[role="alert"]'), null);
    await act(async () => event("files-frozen", true));
    assert.equal(document.querySelector("fieldset").disabled, true);
    const searchesBeforeFreeze = calls.filter((call) => call.method === "files_search").length;
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
      await new Promise((done) => setTimeout(done, 300));
    });
    assert.equal(
      calls.filter((call) => call.method === "files_search").length,
      searchesBeforeFreeze,
    );
    await act(async () => event("files-frozen", false));
    settings = { ...settings, language: "zh-Hans", appearance: "light" };
    await act(async () => event("files-settings-changed"));
    assert.equal(document.querySelector(".file-query"), query);
    assert.equal(query.value, "MATCH_中文");
    assert.equal(document.documentElement.lang, "zh-Hans");
    assert.equal(document.documentElement.dataset.appearance, "light");
    assert.equal(document.querySelector('[role=tab][aria-label="项目搜索"]').ariaSelected, "true");
  } finally {
    await act(async () => root.unmount());
    window.dispatchEvent(new window.Event("pagehide"));
    await server.close();
    dom.window.close();
  }
});
