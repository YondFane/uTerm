import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createServer } from "vite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Maven settings isolate global and project writes, retain overrides and preserve drafts on conflicts", async () => {
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
  const { MavenSettings } = await server.ssrLoadModule("/src/components/MavenSettings.tsx");
  const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
  setUiLanguage("en");
  const globalConfig = {
    distribution: "local",
    home: "/maven",
    settings: "/global.xml",
    repository: "/global-repository",
    wrapper: true,
  };
  let state = {
    revision: "r1",
    global: globalConfig,
    configured: true,
    jdks: [],
    maven_home: "/maven",
    project: {
      maven_scope: "global",
      maven_configured: true,
      maven: { ...globalConfig, repository: "/project-repository" },
      module: ".",
      java_version: 21,
      java_home: "",
      mode: "development",
      maven_profiles: "draft-profile",
      spring_profiles: "dev",
      vm_arguments: [],
      arguments: [],
      jar: "",
      skip_tests: false,
      offline: false,
    },
  };
  const writes = [];
  let failure = false;
  let holdSave = false;
  let releaseSave;
  const busyStates = [];
  let returned;
  let selectedPath = null,
    failPicker = false,
    releasePicker;
  const picks = [];
  mockIPC((command, args) => {
    if (command === "java_configuration") return structuredClone(state);
    if (command === "java_select_path") {
      picks.push(structuredClone(args));
      if (failPicker) throw new Error("JAVA_OPERATION_FAILED");
      return new Promise((resolve) => {
        releasePicker = () => resolve(selectedPath);
      });
    }
    if (command !== "java_save_configuration") throw new Error(command);
    writes.push(structuredClone(args));
    if (failure) throw new Error("JAVA_CONFIG_CONFLICT");
    if (args.global) state.global = structuredClone(args.global);
    if (args.project) state.project = structuredClone(args.project);
    state.revision = "r" + (writes.length + 1);
    if (holdSave)
      return new Promise((resolve) => {
        releaseSave = () => resolve(structuredClone(state));
      });
    return structuredClone(state);
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  const button = (text) =>
    [...document.querySelectorAll("button")].find((node) => node.textContent === text);
  const click = async (text) => {
    assert.ok(button(text), text);
    await act(async () => button(text).click());
  };
  const repository = () =>
    [...document.querySelectorAll("label")]
      .find((label) => label.textContent.startsWith("Maven local repository"))
      .querySelector("input");
  const editRepository = (value) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(
        repository(),
        value,
      );
      repository().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  try {
    await act(async () =>
      root.render(
        React.createElement(MavenSettings, {
          directory: "/project",
          initial: structuredClone(state),
          initialScope: "project",
          saved: (value) => {
            returned = value;
          },
          busyChanged: (value) => {
            busyStates.push(value);
          },
        }),
      ),
    );
    await click("Save project configuration");
    assert.equal(writes.at(-1).global, null);
    assert.equal(writes.at(-1).project.maven.repository, "/project-repository");
    assert.equal(returned.project.maven_scope, "project");
    await click("Inherit system-wide configuration");
    assert.equal(writes.at(-1).project.maven_scope, "global");
    assert.equal(writes.at(-1).project.maven.repository, "/project-repository");
    await click("System-wide configuration");
    await click("Save system-wide configuration");
    assert.equal(writes.at(-1).project, null);
    assert.equal(writes.at(-1).global.settings, "/global.xml");
    assert.equal(returned.project.maven_profiles, "draft-profile");
    await click("Project configuration");
    await editRepository("/project-unsaved");
    await click("System-wide configuration");
    await editRepository("/global-updated");
    await click("Save system-wide configuration");
    await click("Project configuration");
    assert.equal(repository().value, "/project-unsaved");
    await click("Save project configuration");
    assert.equal(writes.at(-1).project.maven.repository, "/project-unsaved");
    await click("System-wide configuration");
    await editRepository("/global-unsaved");
    await click("Project configuration");
    await editRepository("/project-next");
    await click("Save project configuration");
    await click("System-wide configuration");
    assert.equal(repository().value, "/global-unsaved");
    await click("Project configuration");
    failure = true;
    await click("Save project configuration");
    assert.match(document.querySelector('[role="alert"]').textContent, /Another window changed/);
    assert.ok(
      [...document.querySelectorAll("input")].some((node) => node.value === "/project-next"),
    );
    failure = false;
    holdSave = true;
    await click("Save project configuration");
    assert.equal(busyStates.at(-1), true);
    assert.ok(
      [...document.querySelectorAll(".java-scope-tabs button")].every((button) => button.disabled),
    );
    await act(async () => releaseSave());
    assert.equal(busyStates.at(-1), false);
    holdSave = false;
    const pick = (kind, path) =>
      act(async () => {
        selectedPath = path;
        document.querySelector(`button[aria-label="${kind}"]`).click();
      });
    await pick("Choose Maven home", String.raw`\\?\C:\Maven 中文`);
    assert.ok(
      [...document.querySelectorAll(".java-scope-tabs button")].every((button) => button.disabled),
    );
    assert.equal(busyStates.at(-1), true);
    await act(async () => releasePicker());
    assert.equal(busyStates.at(-1), false);
    await pick("Choose Maven settings file", String.raw`\\?\C:\配置\settings.xml`);
    await act(async () => releasePicker());
    await pick("Choose Maven local repository", String.raw`\\?\UNC\server\repo`);
    await act(async () => releasePicker());
    assert.deepEqual(
      picks.map((pick) => pick.kind),
      ["home", "settings", "repository"],
    );
    assert.equal(repository().value, String.raw`\\server\repo`);
    await click("Save project configuration");
    assert.equal(writes.at(-1).project.maven.home, String.raw`C:\Maven 中文`);
    assert.equal(writes.at(-1).project.maven.settings, String.raw`C:\配置\settings.xml`);
    await pick("Choose Maven local repository", null);
    await act(async () => releasePicker());
    assert.equal(repository().value, String.raw`\\server\repo`);
    failPicker = true;
    await pick("Choose Maven settings file", null);
    assert.match(document.querySelector('[role="alert"]').textContent, /failed/i);
    assert.equal(busyStates.at(-1), false);
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
  }
});
