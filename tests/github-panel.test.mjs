import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createServer } from "vite";

test("shared GitHub panel awaits session failures and protects PR forms before showing them", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLDialogElement"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const calls = [],
    guards = [];
  let rejectAssociation,
    resolveAssociation,
    refuseGuard = true;
  const item = {
    number: 7,
    title: "中文",
    url: "https://github.com/fixture-owner/fixture-repo/issues/7",
    state: "OPEN",
    body: "**literal**",
  };
  const port = async (method, params) => {
    calls.push({ method, params });
    if (method === "github_repositories") return ["fixture-owner/fixture-repo"];
    if (method === "github_read") return params.number ? item : [item];
    if (method === "github_prepare_pr")
      return {
        title: "Keep `literal` $(literal)",
        base: "main",
        head: "qa-feature",
        branch: "qa-feature",
      };
    if (method === "github_create_pr") {
      assert.deepEqual(
        Object.keys(params).sort(),
        ["directory", "repository", "title", "body", "base", "head", "draft"].sort(),
      );
      return { number: 99, html_url: "https://github.com/fixture-owner/fixture-repo/pull/99" };
    }
    throw Error(method);
  };
  const button = (text) =>
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  const settle = async () => act(async () => new Promise((done) => setTimeout(done, 350)));
  try {
    const { GitHubPanel } = await server.ssrLoadModule("/src/components/GitHubPanel.tsx");
    const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
    setUiLanguage("en");
    await act(async () =>
      root.render(
        React.createElement(GitHubPanel, {
          directory: "/fixture",
          resizeHandle: null,
          headerActions: null,
          port,
          canAssociate: true,
          canInsert: false,
          associate: () =>
            new Promise((resolve, reject) => {
              resolveAssociation = resolve;
              rejectAssociation = reject;
            }),
          insert: async () => {},
          createSession: async () => {},
          guardForm: async (active) => {
            guards.push(active);
            if (active && refuseGuard) throw Error("guard refused");
          },
        }),
      ),
    );
    await settle();
    await act(async () => document.querySelector(".github-items button").click());
    await act(async () => button("Link current session").click());
    assert.equal(document.querySelector('[role="status"]'), null);
    await act(async () => rejectAssociation(Error("stale session")));
    assert.match(document.querySelector('[role="alert"]').textContent, /stale session/);
    assert.equal(document.querySelector('[role="status"]'), null);
    await act(async () => button("Link current session").click());
    await act(async () => resolveAssociation());
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.equal(document.querySelector('[role="status"]').textContent, "Current session linked.");
    await act(async () => button("Pull Requests").click());
    await settle();
    await act(async () => button("New PR").click());
    assert.equal(document.querySelector("dialog").open, false);
    assert.match(document.querySelector('[role="alert"]').textContent, /guard refused/);
    refuseGuard = false;
    await act(async () => button("New PR").click());
    assert.equal(document.querySelector("dialog").open, true);
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.equal(document.querySelector("dialog input").value, "Keep `literal` $(literal)");
    await act(async () => button("Cancel").click());
    assert.deepEqual(guards, [true, true, false]);
    assert.equal(document.querySelector("dialog").open, false);
    assert.ok(calls.every(({ params }) => params.directory === "/fixture"));
    assert.ok(calls.some(({ method, params }) => method === "github_read" && params.number === 7));
    assert.ok(!calls.some(({ method }) => method === "github_create_pr"));
    await act(async () => button("New PR").click());
    await act(async () =>
      document
        .querySelector("dialog form")
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(calls.filter(({ method }) => method === "github_create_pr").length, 1);
    assert.equal(document.querySelector("dialog").open, false);
    assert.match(document.querySelector('[role="status"]').textContent, /Created PR #99/);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
