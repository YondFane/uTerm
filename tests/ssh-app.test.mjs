import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("App restores SSH sessions without authorizing new logins or running local directory tools", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLDialogElement",
    "Node",
    "localStorage",
  ])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.isTauri = true;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
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
    plugins: [
      {
        name: "ssh-test-renderers",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/TerminalWorkspace") || id.endsWith("/DeferredFileEditor"))
            return "\0ssh-test:" + id.split("/").at(-1);
        },
        load(id) {
          if (id === "\0ssh-test:TerminalWorkspace")
            return `import React from 'react'; export function TerminalWorkspace(props) { globalThis.sshWorkspaceProps = props; return React.createElement('div', null); }`;
          if (id === "\0ssh-test:DeferredFileEditor")
            return `export function DeferredFileEditor() { return null; }`;
        },
      },
    ],
  });
  const { App } = await server.ssrLoadModule("/src/App.tsx");
  const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
  const { emptyWorkspace, workspaceKey } = await server.ssrLoadModule("/src/lib/workspace.ts");
  const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
  const state = emptyWorkspace();
  const target = {
    connection_id: "connection",
    workspace_id: "local",
    name: "Remote QA",
    host: "lab",
    os: "windows",
    root: "C:/Data",
  };
  state.groups[0].sshConnections = [
    {
      id: "connection",
      name: target.name,
      host: target.host,
      os: target.os,
      root: target.root,
      sessions: [
        { id: "existing", name: target.name, shell: "default", directory: "/local", ssh: target },
      ],
    },
  ];
  state.selectedSession = "existing";
  localStorage.setItem(workspaceKey, JSON.stringify(state));
  localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
  const calls = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "runtime_info")
      return {
        platform: "windows",
        home: "/local",
        agents: [],
        agent_definitions: [],
        version: "test",
        debug: true,
        chat_directory: "/local/chats",
      };
    if (["local_session_list", "ssh_session_list"].includes(command))
      return { sessions: [], closed: [] };
    if (command === "ssh_files_open")
      return { connection: target, path: "C:/Data", identity: "a".repeat(64) };
    if (["ssh_files_list", "files_list"].includes(command))
      return { entries: [], partial: false, skipped: 0 };
    if (command === "update_status") return { enabled: false, version: "", downloaded: false };
    return null;
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () =>
      root.render(React.createElement(SettingsProvider, null, React.createElement(App))),
    );
    assert.equal(
      globalThis.sshWorkspaceProps.sshLaunches.size,
      0,
      "Stored sessions can attach but cannot create a new network login",
    );
    assert.ok(document.body.textContent.includes("Remote QA"));
    assert.ok(
      !calls.some((call) => call.command === "ssh_files_open"),
      "Restoring a terminal does not open an SFTP channel",
    );
    assert.ok(
      !document.querySelector('select[aria-label="New session shell"]'),
      "Local shell selector stays hidden for SSH",
    );
    assert.ok(
      !calls.some((call) =>
        ["git_branches", "git_remote_branches", "git_snapshot", "directory_tools"].includes(
          call.command,
        ),
      ),
    );
    const connectionRow = [...document.querySelectorAll(".ssh-connection .row-label")].find(
      (button) => button.textContent === "Remote QA",
    );
    assert.ok(connectionRow);
    await act(async () =>
      connectionRow.dispatchEvent(
        new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      ),
    );
    const newTerminal = [...document.querySelectorAll('[role="menuitem"]')].find(
      (button) => button.textContent === "New SSH terminal",
    );
    assert.ok(newTerminal);
    await act(async () => newTerminal.click());
    const next = JSON.parse(localStorage.getItem(workspaceKey));
    assert.equal(next.groups[0].sshConnections[0].sessions.length, 2);
    assert.equal(globalThis.sshWorkspaceProps.sshLaunches.has("existing"), false);
    assert.equal(globalThis.sshWorkspaceProps.sshLaunches.has(next.selectedSession), true);
    await act(async () => {
      for (const session of next.groups[0].sshConnections[0].sessions)
        globalThis.sshWorkspaceProps.onClosed(session.id);
    });
    const profile = [...document.querySelectorAll("button")].find(
      (button) => button.className === "row-label" && button.textContent === "Remote QA",
    );
    await act(async () => profile.click());
    const welcome = document.querySelector('section.welcome[aria-label="SSH connections"]');
    assert.ok(welcome);
    assert.match(welcome.textContent, /New SSH terminal/);
    const click = async (label) => {
      const button = [...document.querySelectorAll("button")].find(
        (item) => item.textContent === label,
      );
      assert.ok(button, label);
      await act(async () => button.click());
    };
    const input = async (element, value) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
          element,
          value,
        );
        element.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    };
    await click("Quick SSH connection");
    const quick = document.querySelector("dialog[open]");
    assert.ok(quick);
    await input(quick.querySelector("input"), "dev@127.0.0.1:2222");
    await act(async () =>
      quick
        .querySelector("form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    const temporary = JSON.parse(localStorage.getItem(workspaceKey)).groups[0].sshConnections.find(
      (item) => item.temporary,
    );
    assert.ok(temporary);
    assert.equal(temporary.sessions[0].ssh.port, 2222);
    assert.equal(globalThis.sshWorkspaceProps.sshLaunches.has(temporary.sessions[0].id), true);
    const search = document.querySelector('input[aria-label="Search SSH hosts"]');
    await input(search, "no-such-host");
    assert.match(document.body.textContent, /No matching SSH hosts/);
    assert.equal(JSON.parse(localStorage.getItem(workspaceKey)).groups[0].sshConnections.length, 2);
    await input(search, "");
    await act(async () => globalThis.sshWorkspaceProps.onClosed(temporary.sessions[0].id));
    assert.equal(
      JSON.parse(localStorage.getItem(workspaceKey)).groups[0].sshConnections.some(
        (item) => item.id === temporary.id,
      ),
      false,
    );
    await click("Quick SSH connection");
    await input(document.querySelector("dialog[open] input"), "saved-alias");
    await act(async () =>
      document
        .querySelector("dialog[open] form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
    );
    await click("Save connection");
    const saved = JSON.parse(localStorage.getItem(workspaceKey)).groups[0].sshConnections.find(
      (item) => item.host === "saved-alias",
    );
    await act(async () => globalThis.sshWorkspaceProps.onClosed(saved.sessions[0].id));
    assert.equal(
      JSON.parse(localStorage.getItem(workspaceKey)).groups[0].sshConnections.find(
        (item) => item.id === saved.id,
      ).temporary,
      false,
    );
  } finally {
    await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.isTauri;
    delete globalThis.sshWorkspaceProps;
  }
});
