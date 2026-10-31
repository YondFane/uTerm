import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createServer } from "vite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Java component cancellation retains busy state, ignores old status and stops callbacks after unmount", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { JavaComponents } = await server.ssrLoadModule("/src/components/JavaComponents.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const state = {
    busy: false,
    items: [
      {
        id: "maven",
        version: "qa",
        installed: false,
        downloaded: 0,
        size: 1000,
        source: "https://example.com/maven.zip",
      },
    ],
  };
  let releaseInstall, releaseCancel, releaseImport, releaseStatus;
  let holdStatus = false,
    importFailure = false;
  let changed = 0;
  let registered = false;
  let picker = null;
  let holdDetection = false,
    releaseDetection;
  const home = String.raw`C:\Java\Manual 17 中文`;
  const localJdks = () => [
    { version: 21, home: String.raw`\\?\C:\Java\jdk 21 中文` },
    ...(registered ? [{ version: 17, home, registered: true, available: true }] : []),
  ];
  mockIPC((command, args) => {
    if (command.startsWith("plugin:event|")) return 1;
    if (command === "java_detect_jdks") {
      if (holdDetection) {
        holdDetection = false;
        return new Promise((resolve) => {
          releaseDetection = () => resolve(localJdks());
        });
      }
      return localJdks();
    }
    if (command === "java_select_path") return picker;
    if (command === "java_register_jdk") {
      if (args.home !== home) throw new Error("JAVA_JDK_REQUIRED");
      registered = !args.remove;
      return localJdks();
    }
    if (command !== "java_components") throw new Error(command);
    if (args.action === "status") {
      if (holdStatus) {
        holdStatus = false;
        return new Promise((resolve) => {
          releaseStatus = () =>
            resolve({
              ...structuredClone(state),
              busy: true,
              items: [{ ...state.items[0], installed: false }],
            });
        });
      }
      return structuredClone(state);
    }
    if (args.action === "install") {
      state.busy = true;
      return new Promise((resolve) => {
        releaseInstall = () => {
          state.busy = false;
          state.items[0].installed = true;
          resolve(structuredClone(state));
        };
      });
    }
    if (args.action === "cancel") {
      const stale = structuredClone(state);
      return new Promise((resolve) => {
        releaseCancel = () => resolve(stale);
      });
    }
    if (args.action === "import") {
      if (importFailure) throw new Error("DB_COMPONENT_HASH");
      return new Promise((resolve) => {
        releaseImport = () => resolve(structuredClone(state));
      });
    }
    throw new Error(args.action);
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const button = (text) =>
    [...document.querySelectorAll("button")].find((node) => node.textContent === text);
  const click = (text) =>
    act(async () => {
      assert.ok(button(text), text);
      button(text).click();
    });
  let mounted = true;
  try {
    await act(async () =>
      root.render(
        React.createElement(JavaComponents, {
          changed: () => {
            changed++;
          },
        }),
      ),
    );
    assert.equal(
      document.querySelector(".java-detected-jdks .java-local-path").textContent,
      String.raw`C:\Java\jdk 21 中文`,
    );
    assert.equal(
      document.querySelector(".java-detected-jdks .java-local-path").title,
      String.raw`C:\Java\jdk 21 中文`,
    );
    holdDetection = true;
    await click("Detect local JDKs");
    await click("Add local JDK");
    const input = document.querySelector(".java-add-jdk input");
    const enter = (value) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(
          input,
          value,
        );
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    await enter("invalid");
    await click("Choose JDK home");
    assert.equal(input.value, "invalid");
    assert.equal(button("Detect local JDKs").disabled, true);
    await act(async () => releaseDetection());
    assert.equal(button("Detect local JDKs").disabled, false);
    await click("Add");
    assert.ok(document.querySelector('[role="alert"]'));
    assert.equal(input.value, "invalid");
    picker = home;
    await click("Choose JDK home");
    assert.equal(input.value, home);
    await click("Add");
    assert.equal(document.querySelector(".java-add-jdk"), null);
    assert.match(document.querySelector(".java-detected-jdks").textContent, /Manual 17 中文/);
    await click("Remove record");
    assert.equal(registered, false);
    changed = 0;
    await click("Install");
    await click("Cancel installation");
    await act(async () => releaseInstall());
    assert.equal(button("Detect local JDKs").disabled, true);
    await act(async () => releaseCancel());
    assert.equal(button("Detect local JDKs").disabled, false);
    assert.ok(button("Ready"));
    assert.equal(button("Cancel installation"), undefined);
    assert.equal(changed, 1);
    holdStatus = true;
    await click("Detect local JDKs");
    await click("Offline install");
    await act(async () => releaseImport());
    await act(async () => releaseStatus());
    assert.ok(button("Ready"));
    assert.equal(button("Detect local JDKs").disabled, false);
    importFailure = true;
    await click("Offline install");
    assert.match(document.querySelector('[role="alert"]').textContent, /verification|checksum/i);
    await click("Detect local JDKs");
    assert.equal(document.querySelector('[role="alert"]'), null);
    importFailure = false;
    await click("Offline install");
    const before = changed;
    await act(async () => root.unmount());
    mounted = false;
    await act(async () => releaseImport());
    assert.equal(changed, before);
  } finally {
    if (mounted) await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
