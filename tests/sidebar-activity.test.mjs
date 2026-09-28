import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";

test("activity shortcuts follow workspace sessions and preserve original project rows", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "localStorage"])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  try {
    const { Sidebar } = await server.ssrLoadModule("/src/components/Sidebar.tsx");
    const { SettingsProvider } = await server.ssrLoadModule("/src/lib/SettingsContext.tsx");
    const { defaults, settingsKey } = await server.ssrLoadModule("/src/lib/settings.ts");
    const { setUiLanguage } = await server.ssrLoadModule("/src/lib/i18n.ts");
    const { emptyWorkspace, selectSession, moveProject, removeSession } =
      await server.ssrLoadModule("/src/lib/workspace.ts");
    localStorage.setItem(settingsKey, JSON.stringify({ ...defaults, language: "en" }));
    const session = (id, extra = {}) => ({ id, name: id, shell: "default", ...extra });
    let workspace = emptyWorkspace();
    const local = workspace.selectedWorkspace;
    workspace = {
      ...workspace,
      groups: [
        {
          ...workspace.groups[0],
          terminals: [session("loose")],
          chats: [session("chat", { agent: "codex" })],
        },
        { id: "other", name: "Other", selectedProject: null, selectedSession: null },
      ],
      projects: [
        {
          id: "z",
          name: "Zulu",
          directory: "/z",
          workspaceId: local,
          sessions: [
            session("wt", { worktreeId: "tree" }),
            session("shell"),
            session("agent", { agent: "codex" }),
          ],
          worktrees: [{ id: "tree", name: "Tree", path: "/tree", branch: "test" }],
        },
        {
          id: "a",
          name: "Alpha",
          directory: "/a",
          workspaceId: local,
          sessions: [session("alpha")],
        },
        {
          id: "p",
          name: "Pinned",
          directory: "/p",
          workspaceId: local,
          pinned: true,
          sessions: [session("pinned")],
        },
        { id: "empty", name: "Empty", directory: "/empty", workspaceId: local, sessions: [] },
        {
          id: "remote",
          name: "Elsewhere",
          directory: "/elsewhere",
          workspaceId: "other",
          sessions: [session("other")],
        },
      ],
      selectedProject: "z",
      selectedSession: "shell",
    };
    const selected = [];
    const noop = () => {};
    let disabled = false;
    let providerKey = 0;
    const render = () =>
      act(async () =>
        root.render(
          React.createElement(
            SettingsProvider,
            { key: providerKey },
            React.createElement(Sidebar, {
              visible: true,
              toggleVisibility: noop,
              closeSession: noop,
              workspace,
              runtime: null,
              update: noop,
              focus: noop,
              menu: noop,
              addProject: noop,
              newWorkspace: noop,
              renameWorkspace: noop,
              addLoose: noop,
              addSession: noop,
              agentStates: {},
              detectedAgents: {},
              unreadCompletedSessions: new Set(),
              onSessionViewed: noop,
              footerActions: null,
              activityDisabled: disabled,
              onActivitySession: (id) => {
                selected.push(id);
                workspace = selectSession(workspace, id);
              },
            }),
          ),
        ),
      );
    const section = () => document.querySelector('section[aria-label="Active"]');
    const rows = () => [...section().querySelectorAll(".activity-row button")];
    const names = () => rows().map((row) => row.querySelector(".activity-name").textContent);
    const click = (element) => act(async () => element.click());
    await render();
    assert.deepEqual(names(), ["Pinned", "Zulu", "Alpha"]);
    assert.equal(rows()[1].title, "/z");
    assert.equal(rows()[1].getAttribute("aria-label"), "Zulu, 3 sessions");
    assert.equal(rows()[1].getAttribute("aria-current"), "true");
    assert.equal(section().querySelectorAll(".folder-toggle, .row-actions, [draggable]").length, 0);
    assert.ok(document.querySelector('section[aria-label="Pinned"] .folder-row'));
    assert.equal(
      document.querySelector('section[aria-label="Projects"] [data-project-id="z"] .row-label')
        .textContent,
      "Zulu",
    );
    await click(rows()[1]);
    assert.equal(selected.at(-1), "shell");
    workspace = { ...workspace, selectedProject: "a", selectedSession: "alpha" };
    await render();
    await click(rows()[1]);
    assert.equal(selected.at(-1), "wt");
    assert.equal(workspace.selectedProject, "z");
    assert.equal(workspace.selectedWorktree, "tree");
    disabled = true;
    await render();
    const count = selected.length;
    await click(rows()[0]);
    assert.equal(selected.length, count);
    disabled = false;
    await click(section().querySelector(".section-toggle"));
    assert.equal(rows().length, 0);
    await click(section().querySelector(".section-toggle"));
    assert.equal(rows().length, 3);
    workspace = removeSession(workspace, "alpha");
    await render();
    assert.deepEqual(names(), ["Pinned", "Zulu"]);
    workspace = {
      ...workspace,
      projects: workspace.projects.map((p) =>
        p.id === "a" ? { ...p, sessions: [session("new")] } : p,
      ),
    };
    await render();
    assert.deepEqual(names(), ["Pinned", "Zulu", "Alpha"]);
    localStorage.setItem(
      settingsKey,
      JSON.stringify({ ...defaults, language: "en", projectOrder: "name" }),
    );
    providerKey++;
    await render();
    assert.deepEqual(names(), ["Pinned", "Alpha", "Zulu"]);
    workspace = moveProject(workspace, "z", "other");
    await render();
    assert.deepEqual(names(), ["Pinned", "Alpha"]);
    workspace = { ...workspace, selectedWorkspace: "other" };
    await render();
    assert.deepEqual(names(), ["Elsewhere", "Zulu"]);
    workspace = { ...workspace, selectedWorkspace: local, projects: [] };
    await render();
    assert.match(section().textContent, /No active projects/);
    assert.equal(rows().length, 0);
    await act(async () => setUiLanguage("zh-Hans"));
    assert.match(document.querySelector('section[aria-label="活动"]').textContent, /暂无活动项目/);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
