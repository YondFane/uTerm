import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "./vite-server.mjs";

test("quick SSH rejects private input and retains an async attempt until visible failure or success", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const server = await createServer({ configFile: false });
  const { SshQuickConnect } = await server.ssrLoadModule("/src/components/SshQuickConnect.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  let closed = 0;
  let finish;
  let attempts = [];
  const submit = async () =>
    act(async () =>
      document
        .querySelector("form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
  const input = async (value) =>
    act(async () => {
      const field = document.querySelector("input");
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
        field,
        value,
      );
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  try {
    for (const language of ["en", "zh-Hans"]) {
      attempts = [];
      closed = 0;
      await act(async () => {
        setUiLanguage(language);
        root.render(
          React.createElement(SshQuickConnect, {
            key: language,
            close() {
              closed++;
            },
            connect(connection) {
              attempts.push(connection);
              return new Promise((resolve, reject) => {
                finish = { resolve, reject };
              });
            },
          }),
        );
      });
      await input("ssh://dev:private@example.com");
      await submit();
      assert.equal(attempts.length, 0);
      assert.ok(document.querySelector('[role="alert"]'));
      await input("dev@[::1]:2222");
      await submit();
      await submit();
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].host, "::1");
      assert.equal(attempts[0].username, "dev");
      assert.equal(attempts[0].port, 2222);
      assert.equal(attempts[0].temporary, true);
      assert.equal(attempts[0].authentication, "config");
      assert.deepEqual(attempts[0].sessions, []);
      assert.equal(document.querySelector("input").disabled, true);
      assert.ok([...document.querySelectorAll("button")].every((button) => button.disabled));
      await act(async () =>
        document
          .querySelector("dialog")
          .dispatchEvent(new window.Event("cancel", { bubbles: true, cancelable: true })),
      );
      assert.equal(closed, 0);
      await act(async () => finish.reject(Error("CONFLICT")));
      assert.ok(document.querySelector('[role="alert"]'));
      assert.equal(document.querySelector("input").disabled, false);
      assert.equal(document.querySelector("input").value, "dev@[::1]:2222");
      assert.equal(closed, 0);
      await submit();
      await act(async () => finish.resolve(false));
      assert.ok(document.querySelector('[role="alert"]'));
      assert.equal(closed, 0);
      await submit();
      await act(async () => finish.resolve(true));
      assert.equal(closed, 1);
      assert.equal(attempts.length, 3);
      await act(async () =>
        document
          .querySelector("dialog")
          .dispatchEvent(new window.Event("cancel", { bubbles: true, cancelable: true })),
      );
      assert.equal(closed, 2);
    }
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
