import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("global run indicators survive project changes, serialize slow reads and retain failed snapshots", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const originalGlobals = new Map();
  for (const key of ["window", "document", "navigator", "HTMLElement"]) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { useProjectRunSummary, projectRunTitle } = await server.ssrLoadModule(
    "/src/lib/useProjectRunSummary.ts",
  );
  const { ToolbarIcon } = await server.ssrLoadModule("/src/components/SidebarIcon.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const originalTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const polls = new Map();
  let timerId = 0;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 1500) return originalTimeout(callback, delay, ...args);
    const id = { poll: ++timerId };
    polls.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    if (!polls.delete(id)) originalClearTimeout(id);
  };
  const requests = [];
  let status;
  mockIPC((command) => {
    assert.equal(command, "project_run_summary");
    return new Promise((resolve, reject) => requests.push({ resolve, reject }));
  });
  function Probe({ enabled, project, panelOpen }) {
    status = useProjectRunSummary(enabled);
    return React.createElement(
      "div",
      { "data-project": project, "data-panel-open": panelOpen },
      ...["java", "python"].map((language) =>
        React.createElement(
          "button",
          { key: language, title: projectRunTitle(language, status) },
          React.createElement(ToolbarIcon, {
            name: language,
            running: !!status.summary?.[language],
          }),
        ),
      ),
    );
  }
  const root = createRoot(document.getElementById("root"));
  const render = (enabled = true, project = "one", panelOpen = true) =>
    act(async () => root.render(React.createElement(Probe, { enabled, project, panelOpen })));
  const focus = () => act(async () => window.dispatchEvent(new dom.window.Event("focus")));
  const poll = () =>
    act(async () => {
      assert.equal(polls.size, 1);
      const [id, callback] = polls.entries().next().value;
      polls.delete(id);
      callback();
    });
  try {
    await render(false);
    assert.equal(requests.length, 0);
    await render();
    assert.equal(requests.length, 1);
    assert.match(document.querySelector("button").title, /Reading run status/);
    await focus();
    await focus();
    assert.equal(requests.length, 1);
    assert.equal(polls.size, 0);
    await act(async () => requests[0].resolve({ java: 1, python: 2 }));
    assert.equal(requests.length, 2);
    await act(async () => requests[1].resolve({ java: 1, python: 2 }));
    assert.equal(document.querySelectorAll(".toolbar-icon-running").length, 2);
    assert.match(document.querySelectorAll("button")[1].title, /Running projects: 2/);
    assert.equal(document.querySelectorAll(".python-blue,.python-yellow").length, 2);
    const stableStatus = status;
    await render(true, "another-worktree", false);
    assert.equal(status, stableStatus);
    assert.equal(requests.length, 2);
    await poll();
    await act(async () => requests[2].resolve({ java: 1, python: 2 }));
    assert.equal(status, stableStatus);

    await poll();
    await act(async () => requests[3].reject(new Error("host unavailable")));
    assert.deepEqual(status, { summary: { java: 1, python: 2 }, stale: true });
    assert.equal(document.querySelectorAll(".toolbar-icon-running").length, 2);
    assert.match(
      document.querySelectorAll("button")[1].title,
      /Last confirmed running projects: 2/,
    );
    await act(async () => setUiLanguage("zh-Hans"));
    await render();
    assert.match(document.querySelector("button").title, /运行状态暂不可用/);
    assert.match(document.querySelector("button").title, /上次确认：1 个项目运行中/);

    await focus();
    assert.equal(polls.size, 0);
    await act(async () => requests[4].resolve({ java: 0, python: 1 }));
    assert.deepEqual(status, { summary: { java: 0, python: 1 }, stale: false });
    assert.equal(document.querySelectorAll(".toolbar-icon-running").length, 1);
    assert.match(document.querySelector("button").title, /暂无运行项目/);
    await poll();
    await act(async () => requests[5].resolve({ java: 0, python: 0 }));
    assert.equal(document.querySelectorAll(".toolbar-icon-running").length, 0);

    await focus();
    await render(false);
    await render(true);
    const newest = requests.length - 1;
    await act(async () => requests[newest].resolve({ java: 2, python: 0 }));
    await act(async () => requests[newest - 1].resolve({ java: 0, python: 9 }));
    assert.deepEqual(status.summary, { java: 2, python: 0 });
    const rootSnapshot = { java: 2, python: 0, java_roots: ["/one", "/two"], python_roots: [] };
    await focus();
    await act(async () => requests.at(-1).resolve(rootSnapshot));
    const withRoots = status;
    await focus();
    await act(async () =>
      requests.at(-1).resolve({ ...rootSnapshot, java_roots: [...rootSnapshot.java_roots] }),
    );
    assert.equal(status, withRoots);
    await focus();
    await act(async () => requests.at(-1).reject(new Error("host unavailable")));
    assert.equal(status.summary, rootSnapshot);
    assert.equal(status.stale, true);
    await focus();
    const finalRequest = requests.at(-1);
    await act(async () => root.unmount());
    await act(async () => finalRequest.resolve({ java: 0, python: 0 }));
    await focus();
    assert.equal(requests.at(-1), finalRequest);
    assert.equal(polls.size, 0);
  } finally {
    await act(async () => root.unmount());
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    clearMocks();
    await server.close();
    dom.window.close();
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
