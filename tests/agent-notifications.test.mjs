import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

test("Agent reports update indicators, unread completion and guarded native notifications", async () => {
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
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  let focused = true;
  document.hasFocus = () => focused;
  window.Notification = { permission: "denied" };
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    plugins: [
      {
        name: "notification-test-renderers",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/TerminalWorkspace") || id.endsWith("/DeferredFileEditor"))
            return "\0notifications:" + id.split("/").at(-1);
        },
        load(id) {
          if (id === "\0notifications:TerminalWorkspace")
            return "export function TerminalWorkspace(props) { globalThis.agentNotificationProps = props; return null; }";
          if (id === "\0notifications:DeferredFileEditor")
            return "export function DeferredFileEditor() { return null; }";
        },
      },
    ],
  });
  let debug = false;
  let failNotification = false;
  let permissionGranted = true;
  let deferPermission = false;
  const permissionChecks = [];
  const notices = [];
  const acknowledgements = [];
  mockIPC((command, args) => {
    if (command === "runtime_info")
      return {
        platform: "windows",
        architecture: "x86_64",
        home: "/qa",
        agents: ["codex"],
        agent_definitions: [],
        version: "test",
        debug,
        chat_directory: "/qa/chats",
      };
    if (["local_session_list", "ssh_session_list"].includes(command))
      return { sessions: [], closed: [] };
    if (command === "project_worktrees") return [];
    if (command === "update_status") return { enabled: false, version: "", downloaded: false };
    if (command === "git_branches") return { current: "main", local: ["main"] };
    if (command === "files_list") return { entries: [], partial: false, skipped: 0 };
    if (command === "autostart_configure") return false;
    if (command === "control_session") acknowledgements.push(args);
    if (command === "plugin:notification|is_permission_granted")
      return deferPermission
        ? new Promise((resolve) => permissionChecks.push(resolve))
        : permissionGranted;
    if (command === "plugin:notification|notify") {
      if (failNotification) throw Error("QA notification failed");
      notices.push(args.options);
    }
    return null;
  });
  let root;
  try {
    const { App } = await server.ssrLoadModule("/src/App.tsx");
    const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
    const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
    const { emptyWorkspace, workspaceKey } = await server.ssrLoadModule("/src/lib/workspace.ts");
    const { notificationKey } = await server.ssrLoadModule("/src/components/AgentPanel.tsx");
    const { createRoot } = await import("react-dom/client");
    const mount = async () => {
      const workspace = emptyWorkspace();
      workspace.projects = [
        {
          id: "project",
          name: "QA",
          directory: "/qa",
          workspaceId: workspace.selectedWorkspace,
          worktrees: [],
          sessions: ["selected", "background"].map((id) => ({
            id,
            name: id,
            agent: "codex",
            shell: "default",
            pinned: false,
          })),
        },
      ];
      workspace.selectedProject = "project";
      workspace.selectedSession = "selected";
      localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
      localStorage.setItem(workspaceKey, JSON.stringify(workspace));
      localStorage.setItem(notificationKey, "true");
      root = createRoot(document.getElementById("root"));
      await act(async () =>
        root.render(React.createElement(SettingsProvider, null, React.createElement(App))),
      );
    };
    const report = (id, state, initial = false) =>
      act(async () => globalThis.agentNotificationProps.onAgentState(id, state, initial));
    const row = (id) =>
      [...document.querySelectorAll(".session-row")].find(
        (node) => node.querySelector(".row-label").textContent === id,
      );
    const indicator = (id) => row(id).querySelector(".agent-state");
    await mount();
    await report("background", "idle", true);
    assert.equal(indicator("background").title, "Idle");
    await report("background", "working");
    assert.ok(indicator("background").classList.contains("working"));
    assert.equal(notices.length, 0);
    await report("background", "waiting");
    assert.equal(indicator("background").title, "Needs attention");
    assert.deepEqual(notices, [{ title: "background", body: "Needs your attention" }]);
    await report("background", "waiting");
    assert.equal(notices.length, 1, "Repeated state does not notify twice");
    await report("background", "done");
    assert.ok(indicator("background").classList.contains("done"));
    assert.ok(row("background").classList.contains("completion-unread"));
    assert.deepEqual(notices.at(-1), { title: "background", body: "Task completed" });
    await act(async () => globalThis.agentNotificationProps.onSessionViewed("background"));
    assert.ok(!row("background").classList.contains("completion-unread"));
    assert.ok(indicator("background").classList.contains("idle"));
    assert.ok(
      acknowledgements.some((item) => item.id === "background" && item.action === "acknowledge"),
    );
    await report("selected", "working");
    await report("selected", "done");
    assert.equal(notices.length, 2, "Viewing a foreground session suppresses the toast");
    focused = false;
    await report("selected", "working");
    await report("selected", "done");
    assert.equal(notices.length, 3, "A selected session still notifies while the app is unfocused");
    await report("background", "working");
    await report("background", "done", true);
    assert.equal(notices.length, 3, "Restored completion does not notify");
    localStorage.setItem(notificationKey, "false");
    await report("background", "working");
    await report("background", "done");
    assert.equal(notices.length, 3, "Notifications are opt in");
    localStorage.setItem(notificationKey, "true");
    permissionGranted = false;
    await report("background", "waiting");
    assert.equal(notices.length, 3, "Denied OS permission suppresses the toast");
    permissionGranted = true;
    failNotification = true;
    await report("background", "done");
    assert.match(document.body.textContent, /QA notification failed/);
    failNotification = false;
    const settlePermissions = () =>
      act(async () => permissionChecks.splice(0).forEach((resolve) => resolve(true)));
    deferPermission = true;
    await report("background", "working");
    await report("background", "waiting");
    assert.equal(permissionChecks.length, 1);
    localStorage.setItem(notificationKey, "false");
    await settlePermissions();
    assert.equal(notices.length, 3, "Opting out cancels a pending notification");
    localStorage.setItem(notificationKey, "true");
    await report("background", "working");
    await report("background", "waiting");
    await report("background", "working");
    await settlePermissions();
    assert.equal(notices.length, 3, "A newer state cancels a stale attention notification");
    await report("background", "waiting");
    focused = true;
    await act(async () => row("background").querySelector(".row-label").click());
    assert.equal(globalThis.agentNotificationProps.workspace.selectedSession, "background");
    await settlePermissions();
    assert.equal(notices.length, 3, "Viewing the session cancels a pending notification");
    await report("selected", "working");
    await report("selected", "waiting");
    await act(async () => globalThis.agentNotificationProps.onClosed("selected"));
    await settlePermissions();
    assert.equal(notices.length, 3, "Closing a session cancels its pending notification");
    focused = false;
    await report("background", "working");
    await report("background", "waiting");
    await report("background", "done");
    await settlePermissions();
    assert.equal(notices.length, 4, "Only the latest pending state notifies");
    assert.equal(notices.at(-1).body, "Task completed");
    await report("background", "working");
    await report("background", "waiting");
    await act(async () => root.unmount());
    await settlePermissions();
    assert.equal(notices.length, 4, "Unmounting cancels pending notifications");
    deferPermission = false;
    debug = true;
    await mount();
    await report("background", "working");
    await report("background", "waiting");
    await report("background", "done");
    assert.equal(notices.length, 4, "Development builds do not send task notifications");
    await act(async () => root.unmount());
    debug = false;
    await mount();
    const activity = (id, kind, source = "events") => ({ id, sequence: 10, kind, source });
    const emit = (event) =>
      act(async () => globalThis.agentNotificationProps.onAgentEvent("background", event));
    await act(async () =>
      globalThis.agentNotificationProps.onAgentState("background", "done", false, true),
    );
    assert.equal(notices.length, 4, "Event-capable hosts do not also notify for state changes");
    await emit(activity("turn-a", "done"));
    await emit(activity("turn-a", "done"));
    assert.equal(notices.length, 5, "Replayed event IDs are ignored");
    await emit(activity("turn-b", "done"));
    assert.equal(
      notices.length,
      6,
      "Consecutive completions each notify without an intermediate working state",
    );
    await act(async () =>
      globalThis.agentNotificationProps.onAgentState("background", "notice", false, true),
    );
    await emit(activity("bell", "notice", "terminal"));
    assert.equal(notices.at(-1).body, "Session has a new notification");
    assert.equal(indicator("background").title, "Session has a new notification");
    assert.ok(!row("background").classList.contains("completion-unread"));
    await act(async () =>
      globalThis.agentNotificationProps.onAgentState("background", "error", false, true),
    );
    await emit(activity("failed-turn", "error"));
    assert.equal(notices.at(-1).body, "Task failed");
    const latestCount = notices.length;
    await emit(activity("older-completion", "done"));
    assert.equal(
      notices.length,
      latestCount,
      "A completion preceding a newer failure does not notify or highlight",
    );
    assert.ok(!row("background").classList.contains("completion-unread"));
  } finally {
    if (root) await act(async () => root.unmount());
    clearMocks();
    await server.close();
    dom.window.close();
    delete globalThis.isTauri;
    delete globalThis.agentNotificationProps;
  }
});
