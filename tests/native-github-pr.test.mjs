import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";

test("native workspace PR form retries reads, retains literal drafts and drains one explicit write", async () => {
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
  const { NativeGitHubPR } = await server.ssrLoadModule("/src/native-github-pr.tsx");
  const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
  const { defaults } = await server.ssrLoadModule("/src/lib/settings.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  let settings = { ...defaults, language: "en" },
    refuseContext = true,
    rejectWrite,
    resolveWrite;
  const calls = [];
  window.utermContentDocument = "pr-test";
  const event = (kind, payload) =>
    window.dispatchEvent(
      new window.CustomEvent("uterm-content-event", {
        detail: { version: 1, document: "pr-test", kind, payload },
      }),
    );
  window.webkit = {
    messageHandlers: {
      utermContent: {
        async postMessage(message) {
          calls.push(message);
          const { method, params } = message;
          let result = null,
            error;
          if (method === "github_pr_context") {
            assert.deepEqual(params, {});
            if (refuseContext) error = { code: "READ_FAILED", message: "PR context failed" };
            else
              result = {
                repository: "fixture-owner/fixture-repo",
                title: "Initial 中文",
                base: "release",
                head: "qa-feature",
              };
          } else if (method === "github_pr_submit") {
            assert.deepEqual(
              Object.keys(params).sort(),
              ["title", "body", "base", "head", "draft"].sort(),
            );
            try {
              result = await new Promise((resolve, reject) => {
                rejectWrite = reject;
                resolveWrite = resolve;
              });
            } catch (reason) {
              error = { code: "GITHUB_ERROR", message: String(reason) };
            }
          } else if (method !== "github_pr_close") assert.fail(method);
          return {
            version: 1,
            id: message.id,
            document: message.document,
            result,
            ...(error && { error }),
          };
        },
      },
    },
  };
  const click = async (title) =>
    act(async () => {
      const button = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === title,
      );
      assert.ok(button, title);
      button.click();
    });
  const submit = async () =>
    act(async () =>
      document
        .querySelector("dialog form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
  const cancel = async () =>
    act(async () =>
      document
        .querySelector("dialog")
        .dispatchEvent(new window.Event("cancel", { bubbles: true, cancelable: true })),
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
          React.createElement(NativeGitHubPR),
        ),
      ),
    );
    assert.match(document.querySelector('[role="alert"]').textContent, /context failed/);
    assert.ok(document.querySelector("dialog").open);
    assert.ok(!calls.some((c) => c.method === "github_pr_submit"));
    refuseContext = false;
    await click("Retry");
    const input = document.querySelector("dialog input"),
      body = document.querySelector("dialog textarea");
    const literalTitle = "Keep `literal` $(literal) 中文",
      literalBody = "Line one\n$(literal)\n`literal` 中文";
    await act(async () => {
      for (const [field, proto, value] of [
        [input, window.HTMLInputElement.prototype, literalTitle],
        [body, window.HTMLTextAreaElement.prototype, literalBody],
      ]) {
        Object.getOwnPropertyDescriptor(proto, "value").set.call(field, value);
        field.dispatchEvent(new window.Event("input", { bubbles: true }));
      }
    });
    settings = { ...settings, language: "zh-Hans", appearance: "light" };
    await act(async () => event("github-pr-settings-changed", null));
    assert.equal(document.querySelector("dialog input"), input);
    assert.equal(input.value, literalTitle);
    assert.equal(body.value, literalBody);
    assert.match(document.querySelector("dialog h2").textContent, /新建/);
    await act(async () => event("github-pr-frozen", true));
    await submit();
    await cancel();
    assert.ok(!calls.some((c) => ["github_pr_submit", "github_pr_close"].includes(c.method)));
    await act(async () => event("github-pr-frozen", false));
    await submit();
    await submit();
    await cancel();
    assert.equal(calls.filter((c) => c.method === "github_pr_submit").length, 1);
    assert.ok(
      [...document.querySelectorAll("dialog input, dialog textarea, dialog button")].every(
        (c) => c.disabled,
      ),
    );
    assert.ok(!calls.some((c) => c.method === "github_pr_close"));
    await act(async () => rejectWrite(Error("Ambiguous fixture result")));
    assert.match(document.querySelector('[role="alert"]').textContent, /请先刷新列表/);
    assert.equal(input.value, literalTitle);
    assert.equal(body.value, literalBody);
    assert.equal(calls.filter((c) => c.method === "github_pr_submit").length, 1);
    await submit();
    assert.deepEqual(calls.filter((c) => c.method === "github_pr_submit").at(-1).params, {
      title: literalTitle,
      body: literalBody,
      base: "release",
      head: "qa-feature",
      draft: true,
    });
    await act(async () => resolveWrite({ number: 99 }));
    await click("取消");
    assert.equal(calls.filter((c) => c.method === "github_pr_close").length, 1);
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
