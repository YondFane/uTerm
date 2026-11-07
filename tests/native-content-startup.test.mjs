import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { act } from "react";

for (const [language, retryTitle] of [
  ["en", "Retry"],
  ["zh-Hans", "重试"],
]) {
  test(`native content uses its application language and retries repeated startup failure (${language})`, async () => {
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
    window.utermContentDocument = "bootstrap-document";
    window.utermContentLanguage = language;
    const pending = Promise.withResolvers();
    let attempts = 0;
    let settings;
    window.webkit = {
      messageHandlers: {
        utermContent: {
          async postMessage(message) {
            assert.equal(message.kind, "request");
            assert.equal(message.method, "content_context");
            assert.equal(message.document, "bootstrap-document");
            attempts++;
            if (attempts === 2) await pending.promise;
            return {
              version: 1,
              id: message.id,
              document: message.document,
              ...(attempts <= 2
                ? {
                    error: {
                      code: "WRITER_BUSY",
                      message: "Another writer owns the canonical store",
                    },
                  }
                : {
                    result: {
                      kind: "git",
                      directory: "/isolated",
                      path: "",
                      editable: false,
                      settings,
                    },
                  }),
            };
          },
        },
      },
    };
    const server = await createServer({
      configFile: false,
      server: { middlewareMode: true, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [
        {
          name: "bootstrap-content-body",
          enforce: "pre",
          resolveId(id) {
            if (id === "./native-git") return "\0bootstrap-git";
          },
          load(id) {
            if (id === "\0bootstrap-git")
              return `import React from 'react'; export function NativeGit({directory}) { return React.createElement('p', {'data-ready':directory}, 'Loaded'); }`;
          },
        },
      ],
    });
    try {
      settings = {
        ...(await server.ssrLoadModule("/src/lib/settings.ts")).defaults,
        language: "en",
      };
      await act(async () => {
        await server.ssrLoadModule("/src/native-content.tsx");
      });
      assert.match(document.querySelector('[role="alert"]').textContent, /Another writer/);
      assert.equal(attempts, 1);
      assert.equal(document.documentElement.lang, language);
      assert.equal(document.querySelector("button").textContent.trim(), retryTitle);
      assert.equal(
        document.querySelector("main").classList.contains("native-content-startup-error"),
        true,
      );
      await act(async () => {
        document.querySelector("button").click();
      });
      assert.equal(attempts, 2);
      assert.equal(document.querySelector("button").disabled, true);
      document.querySelector("button").click();
      assert.equal(attempts, 2);
      await act(async () => {
        pending.resolve();
      });
      assert.equal(document.querySelector("button").disabled, false);
      assert.match(document.querySelector('[role="alert"]').textContent, /Another writer/);
      await act(async () => {
        document.querySelector("button").click();
      });
      assert.equal(document.querySelector("[data-ready]").getAttribute("data-ready"), "/isolated");
      assert.equal(document.querySelector('[role="alert"]'), null);
    } finally {
      window.dispatchEvent(new window.Event("pagehide"));
      await server.close();
      dom.window.close();
    }
  });
}
