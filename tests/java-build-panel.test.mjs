import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createServer } from "vite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Java panel recovers detection, protects pending drafts and ignores stale task and tool responses", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLDialogElement"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const frameCallbacks = new Map();
  let frameSequence = 0;
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++frameSequence;
    frameCallbacks.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frameCallbacks.delete(id);
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  dom.window.HTMLElement.prototype.setPointerCapture = function () {
    this.captured = true;
  };
  dom.window.HTMLElement.prototype.hasPointerCapture = function () {
    return !!this.captured;
  };
  dom.window.HTMLElement.prototype.releasePointerCapture = function () {
    this.captured = false;
  };
  Object.defineProperty(document.getElementById("root"), "clientHeight", { value: 700 });

  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    plugins: [
      {
        name: "java-panel-renderers",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/TerminalView") || id.endsWith("/JavaComponents"))
            return "\0java-panel:" + id.split("/").at(-1);
        },
        load(id) {
          if (id === "\0java-panel:TerminalView")
            return 'import React from "react"; export function TerminalView(props) { React.useEffect(() => { globalThis.javaTaskTerminalMounts = (globalThis.javaTaskTerminalMounts ?? 0) + 1; }, []); globalThis.javaTaskTerminal = props; return React.createElement("div", {"data-task":props.session.id}); }';
          if (id === "\0java-panel:JavaComponents")
            return "export function JavaComponents(props) { globalThis.javaToolsChanged = props.changed; return null; }";
        },
      },
    ],
  });
  const { JavaBuildPanel } = await server.ssrLoadModule("/src/components/JavaBuildPanel.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  let state = {
    revision: "r1",
    global: { distribution: "local", home: "/maven", settings: "", repository: "", wrapper: true },
    configured: true,
    jdks: [
      { home: String.raw`\\?\C:\Java\jdk21`, version: 21 },
      { home: String.raw`C:\Java\Manual 17 中文`, version: 17, registered: true, available: true },
    ],
    maven_home: "/maven",
    project: {
      maven_scope: "global",
      maven_configured: false,
      maven: { distribution: "local", home: "", settings: "", repository: "", wrapper: true },
      module: ".",
      java_version: 21,
      java_home: "",
      mode: "jar",
      maven_profiles: "",
      spring_profiles: "dev",
      vm_arguments: [],
      arguments: [],
      jar: "target/app.jar",
      skip_tests: false,
      offline: false,
    },
  };
  const info = {
    modules: [
      {
        path: ".",
        name: "fixture",
        packaging: "jar",
        java_version: 21,
        boot: true,
        jars: ["target/app.jar"],
        main_classes: [
          { name: "example.FirstApplication", spring_boot: true },
          { name: "example.SecondApplication", spring_boot: false },
          { name: "example.Helper", spring_boot: false },
        ],
      },
    ],
  };
  const task = {
    spec: { id: "new-task", directory: "/project", shell: "default", agent: null },
    generation: "generation",
    task: { root: "/project", name: "fixture", action: "run", created: 1 },
    running: true,
    code: null,
  };
  let pomFailure = true,
    holdStart = false,
    holdTasks = false;
  let releaseStart, releaseTasks;
  let tasks = [];
  const writes = [];
  mockIPC((command, args) => {
    if (command === "java_configuration") return structuredClone(state);
    if (command === "java_project") {
      if (pomFailure) throw new Error("JAVA_POM_INVALID");
      return structuredClone(info);
    }
    if (command === "java_tasks") {
      if (holdTasks)
        return new Promise((resolve) => {
          releaseTasks = () => resolve([]);
        });
      return structuredClone(tasks);
    }
    if (command === "java_save_configuration") {
      writes.push(structuredClone(args));
      if (args.revision !== state.revision) throw new Error("JAVA_CONFIG_CONFLICT");
      state = {
        ...state,
        revision: "r" + (writes.length + 1),
        project: structuredClone(args.project),
      };
      return structuredClone(state);
    }
    if (command === "java_start") {
      assert.equal(args.config.jar, "target/app.jar");
      assert.equal(args.config.main_class, "custom.ManualApplication");
      if (holdStart)
        return new Promise((resolve) => {
          releaseStart = () => {
            tasks = [task];
            resolve(task);
          };
        });
      return task;
    }
    if (command === "java_stop") throw new Error("STOP_DENIED");
    throw new Error(command);
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  let prepare,
    closed = 0;
  const props = {
    directory: String.raw`\\?\D:\project`,
    close: () => {
      closed++;
    },
    registerClose: (value) => {
      prepare = value;
    },
  };
  const render = (visible) =>
    act(async () => root.render(React.createElement(JavaBuildPanel, { ...props, visible })));
  const button = (text) =>
    [...document.querySelectorAll("button")].find((node) => node.textContent === text);
  const click = (text) =>
    act(async () => {
      assert.ok(button(text), text);
      button(text).click();
    });
  const field = (text) =>
    [...document.querySelectorAll("label")]
      .find((label) => label.textContent.startsWith(text))
      ?.querySelector("input,textarea,select");
  const input = async (text, value) =>
    act(async () => {
      const element = field(text);
      assert.ok(element, text);
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set.call(
        element,
        value,
      );
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  try {
    await render(true);
    assert.match(document.querySelector('[role="alert"]').textContent, /pom.xml/);
    pomFailure = false;
    await click("Check again");
    assert.ok(field("Target module"));
    assert.equal(document.querySelector(".java-project-path").textContent, String.raw`D:\project`);
    assert.equal(document.querySelector(".java-project-path").title, String.raw`D:\project`);
    assert.equal(document.querySelector(".java-local-path").textContent, String.raw`C:\Java\jdk21`);

    const panel = document.querySelector(".java-build-panel");
    const resizer = () =>
      document.querySelector('[role="separator"][aria-label="Resize build and run panel"]');
    panel.getBoundingClientRect = () => ({
      height: Number.parseFloat(panel.style.getPropertyValue("--java-panel-height")),
    });
    const pointer = async (type, y) =>
      act(async () => {
        const event = new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientY: y });
        Object.defineProperty(event, "pointerId", { value: 1 });
        resizer().dispatchEvent(event);
      });
    await pointer("pointerdown", 500);
    await pointer("pointermove", 350);
    for (const callback of frameCallbacks.values()) callback();
    frameCallbacks.clear();
    assert.equal(panel.style.getPropertyValue("--java-panel-height"), "530px");
    assert.equal(resizer().getAttribute("aria-valuenow"), "380");
    await pointer("pointerup", 350);
    assert.equal(resizer().getAttribute("aria-valuenow"), "530");
    assert.equal(panel.hasAttribute("data-resizing"), false);
    await pointer("pointerdown", 400);
    await pointer("pointermove", 100);
    for (const callback of frameCallbacks.values()) callback();
    frameCallbacks.clear();
    assert.equal(panel.style.getPropertyValue("--java-panel-height"), "612px");
    await pointer("pointercancel", 100);
    assert.equal(panel.style.getPropertyValue("--java-panel-height"), "530px");
    const key = async (value) =>
      act(async () =>
        resizer().dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { bubbles: true, key: value }),
        ),
      );
    await key("Home");
    assert.equal(resizer().getAttribute("aria-valuenow"), "240");
    await key("End");
    assert.equal(resizer().getAttribute("aria-valuenow"), "612");
    await key("ArrowDown");
    assert.equal(resizer().getAttribute("aria-valuenow"), "588");
    await act(async () =>
      resizer().dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })),
    );
    assert.equal(resizer().getAttribute("aria-valuenow"), "380");
    const maximize = document.querySelector('[aria-label="Expand run panel"]');
    await act(async () => maximize.click());
    assert.equal(resizer(), null);
    await act(async () => document.querySelector('[aria-label="Restore run panel"]').click());
    assert.equal(resizer().getAttribute("aria-valuenow"), "380");
    const select = async (label, value) =>
      act(async () => {
        const element = field(label);
        element.value = value;
        element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
    await select("Launch mode", "development");
    assert.equal(field("Main class").options.length, 5);
    assert.match(field("Main class").options[0].textContent, /example.FirstApplication/);
    info.modules[0].main_classes[1].spring_boot = true;
    await click("Check again");
    await click("Run");
    assert.equal(writes.length, 0);
    assert.match(document.querySelector('[role="alert"]').textContent, /Multiple main classes/);
    await select("Main class", "example.SecondApplication");
    assert.equal(field("Main class").value, "example.SecondApplication");
    await select("Main class", "custom");
    await input("Fully qualified main class", "example.FirstApplication");
    assert.equal(field("Fully qualified main class").value, "example.FirstApplication");
    await input("Fully qualified main class", "custom.ManualApplication");
    await click("Check again");
    assert.equal(field("Fully qualified main class").value, "custom.ManualApplication");
    await select("Launch mode", "jar");
    assert.equal(field("Main class"), undefined);
    await input("JVM arguments", '"-Dname=unsaved value"');
    await input("Environment variables", "TOKEN=temporary");
    holdStart = true;
    await click("Run");
    assert.ok(releaseStart);
    assert.equal(await prepare(), false);
    assert.equal(writes.length, 1);
    assert.equal(closed, 0);
    assert.ok(
      [
        ...document.querySelectorAll(
          ".java-run-configuration input,.java-run-configuration textarea,.java-run-configuration select",
        ),
      ].every((node) => node.disabled),
    );
    holdTasks = true;
    await render(false);
    await render(true);
    assert.ok(releaseTasks);
    await act(async () => releaseStart());
    holdTasks = false;
    await act(async () => releaseTasks());
    assert.equal(globalThis.javaTaskTerminal.session.id, "new-task");
    const terminalBeforeDrag = globalThis.javaTaskTerminal;
    await pointer("pointerdown", 500);
    await pointer("pointermove", 400);
    for (const callback of frameCallbacks.values()) callback();
    frameCallbacks.clear();
    assert.equal(globalThis.javaTaskTerminal, terminalBeforeDrag);
    await pointer("pointerup", 400);
    assert.equal(globalThis.javaTaskTerminalMounts, 1);

    assert.match(document.querySelector(".java-task-state").textContent, /Process running/);
    await render(false);
    assert.equal(document.querySelector(".java-build-panel").hidden, true);
    assert.equal(globalThis.javaTaskTerminal.visible, false);
    await render(true);
    assert.equal(field("JVM arguments").value, '"-Dname=unsaved value"');
    assert.equal(field("Environment variables").value, "TOKEN=temporary");
    await click("Stop");
    assert.ok(button("Force stop"));
    assert.match(document.querySelector('[role="alert"]').textContent, /STOP_DENIED/);
    await click("Manage tools");
    state = {
      ...state,
      revision: "external",
      project: { ...state.project, maven_profiles: "external-profile" },
    };
    await act(async () => globalThis.javaToolsChanged());
    const close = document.querySelector('dialog [aria-label="Close"]');
    await act(async () => close.click());
    await click("Rerun");
    assert.equal(writes.at(-1).revision, "r2");
    assert.match(document.querySelector('[role="alert"]').textContent, /Another window changed/);
    assert.equal(field("JVM arguments").value, '"-Dname=unsaved value"');
    await click("Reload saved configuration");
    assert.equal(field("Maven profile").value, "external-profile");
    info.modules.push({ ...info.modules[0], path: "child", name: "child", main_classes: [] });
    await select("Launch mode", "development");
    assert.equal(field("Fully qualified main class").value, "custom.ManualApplication");
    await input("Fully qualified main class", "example.FirstApplication");
    assert.equal(field("Fully qualified main class").value, "example.FirstApplication");
    await click("Check again");
    await select("Target module", "child");
    await select("Launch mode", "development");
    assert.equal(field("Main class").value, "");
    assert.equal(field("Fully qualified main class"), undefined);
    assert.match(
      document.querySelector(".java-main-class-field").textContent,
      /No main class detected/,
    );
    await select("JDK version", String.raw`home:C:\Java\Manual 17 中文`);
    await act(async () => {
      assert.equal(await prepare(), true);
    });
    assert.equal(writes.at(-1).project.java_home, String.raw`C:\Java\Manual 17 中文`);
    assert.equal(writes.at(-1).project.java_version, 17);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.javaTaskTerminal;
    delete globalThis.javaTaskTerminalMounts;
    delete globalThis.javaToolsChanged;
  }
});
