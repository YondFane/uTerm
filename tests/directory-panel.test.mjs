import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("directory GitLab action follows GitHub and handles pending requests and localized errors", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  let resolveOpen;
  let fail = false;
  mockIPC((command, args) => {
    if (command === "directory_tools") return [{ id: "idea", name: "IntelliJ IDEA" }];
    assert.equal(command, "directory_open");
    calls.push(args);
    if (fail) throw "此工作目录没有 GitLab 远程仓库。";
    return new Promise((resolve) => (resolveOpen = resolve));
  });
  try {
    const { DirectoryPanel } = await server.ssrLoadModule("/src/components/DirectoryPanel.tsx");
    const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
    await act(async () => {
      setUiLanguage("zh-Hans");
      root.render(
        React.createElement(DirectoryPanel, {
          directory: "/项目/a b",
          platform: "macos",
          resizeHandle: null,
          headerActions: null,
        }),
      );
    });
    const buttons = () => [...document.querySelectorAll(".directory-actions button")];
    const gitlab = () => buttons().find((button) => button.textContent.includes("GitLab"));
    const labels = buttons().map((button) => button.textContent);
    assert.equal(labels[labels.indexOf("在 GitHub 上查看") + 1], "在 GitLab 上查看");
    assert.ok(labels.indexOf("在 GitLab 上查看") < labels.indexOf("在 IntelliJ IDEA 中打开"));
    await act(async () => gitlab().click());
    assert.deepEqual(calls, [{ directory: "/项目/a b", target: "gitlab" }]);
    assert.ok(gitlab().disabled);
    assert.ok(buttons().find((button) => button.textContent.includes("GitHub")).disabled);
    await act(async () => resolveOpen());
    assert.equal(gitlab().disabled, false);

    fail = true;
    await act(async () => gitlab().click());
    assert.equal(
      document.querySelector('[role="alert"]').textContent,
      "此工作目录没有 GitLab 远程仓库。",
    );
    await act(async () => setUiLanguage("en"));
    assert.equal(gitlab().textContent, "View on GitLab");
    assert.equal(
      document.querySelector('[role="alert"]').textContent,
      "This working directory has no GitLab remote.",
    );
    fail = false;
    await act(async () => gitlab().click());
    assert.equal(document.querySelector('[role="alert"]'), null);
    await act(async () => resolveOpen());
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
