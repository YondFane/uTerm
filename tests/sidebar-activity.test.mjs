import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import React, { act } from "react";

test("active project trees move between sections without duplicating pinned children", async () => {
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
    const {
      emptyWorkspace,
      selectSession,
      moveProject,
      removeSession,
      removeProject,
      reorderProject,
    } = await server.ssrLoadModule("/src/lib/workspace.ts");
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
          collapsed: true,
          sessions: [
            session("wt", { worktreeId: "tree", pinned: true }),
            session("shell"),
            session("agent", { agent: "codex", pinned: true }),
          ],
          worktrees: [
            {
              id: "tree",
              name: "Tree",
              path: "/tree",
              branch: "test",
              pinned: true,
              collapsed: true,
            },
            { id: "unused", name: "Unused", path: "/unused", branch: "unused" },
          ],
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
    const menus = [];
    const closed = [];
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
              closeSession: (id) => closed.push(id),
              workspace,
              runtime: null,
              update: (change) => {
                workspace = change(workspace);
              },
              focus: noop,
              menu: (value) => menus.push(value),
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
    const rows = () => [...(section()?.querySelectorAll("[data-project-id] > .row-label") ?? [])];
    const names = () => rows().map((row) => row.textContent);
    const click = (element) => act(async () => element.click());
    const sessions = () => [...section().querySelectorAll(".session-row > .row-label")];
    const projectRow = (id) => document.querySelector(`[data-project-id="${id}"]`);
    const toggle = (name) =>
      [...section().querySelectorAll(".folder-toggle")].find((button) =>
        button.getAttribute("aria-label").endsWith(name),
      );
    await render();
    for (const name of ["shell", "agent", "wt", "loose", "chat"]) {
      const label = [...document.querySelectorAll(".session-row > .row-label")].find(
        (button) => button.textContent.trim() === name || button.title.endsWith(` / ${name}`),
      );
      assert.ok(label, name);
      const down = new dom.window.MouseEvent("mousedown", {
        button: 1,
        bubbles: true,
        cancelable: true,
      });
      const middle = new dom.window.MouseEvent("auxclick", {
        button: 1,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        label.dispatchEvent(down);
        label.dispatchEvent(middle);
        label.dispatchEvent(new dom.window.MouseEvent("auxclick", { button: 2, bubbles: true }));
      });
      assert.equal(down.defaultPrevented, true);
      assert.equal(middle.defaultPrevented, true);
    }
    assert.deepEqual(closed, ["shell", "agent", "wt", "loose", "chat"]);
    assert.deepEqual(selected, []);
    assert.equal(workspace.selectedSession, "shell");
    assert.deepEqual(names(), ["Pinned", "Zulu", "Alpha"]);
    assert.equal(rows()[1].title, "/z");
    assert.equal(document.querySelectorAll('[data-project-id="z"]').length, 1);
    assert.equal(document.querySelector('section[aria-label="Pinned"]'), null);
    assert.equal(
      document.querySelector('section[aria-label="Projects"] [data-project-id="z"]'),
      null,
    );
    assert.equal(section().querySelector(".activity-count"), null);
    assert.equal(sessions().length, 5);
    assert.equal(toggle("Tree").getAttribute("aria-expanded"), "true");
    assert.ok(toggle("Unused"));
    assert.equal(workspace.projects[0].collapsed, true);
    assert.equal(workspace.projects[0].worktrees[0].collapsed, true);
    assert.equal(removeProject(workspace, "z"), workspace);
    await act(async () =>
      projectRow("z").dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })),
    );
    assert.equal(menus.at(-1).kind, "project");
    assert.equal(menus.at(-1).id, "z");
    await click(rows()[1]);
    assert.equal(selected.at(-1), "shell");
    workspace = { ...workspace, selectedProject: "a", selectedSession: "alpha" };
    await render();
    await click(rows()[1]);
    assert.equal(selected.at(-1), "wt");
    assert.equal(workspace.selectedWorktree, "tree");
    await click(sessions().find((button) => button.title === "Zulu / agent"));
    assert.equal(selected.at(-1), "agent");
    disabled = true;
    await render();
    const count = selected.length;
    await click(rows()[0]);
    await click(sessions()[0]);
    assert.equal(selected.length, count);
    disabled = false;
    await render();
    await click(toggle("Zulu"));
    await render();
    assert.equal(toggle("Zulu").getAttribute("aria-expanded"), "false");
    assert.equal(toggle("Tree"), undefined);
    await click(toggle("Zulu"));
    await render();
    await click(toggle("Tree"));
    await render();
    assert.equal(toggle("Tree").getAttribute("aria-expanded"), "false");
    await click(section().querySelector(".section-action"));
    await render();
    assert.equal(rows().length, 3);
    assert.equal(sessions().length, 0);
    assert.equal(workspace.projects[1].collapsed, undefined);
    await click(section().querySelector(".section-action"));
    await render();
    assert.equal(sessions().length, 5);
    await click(section().querySelector(".section-toggle"));
    assert.equal(rows().length, 0);
    await click(section().querySelector(".section-toggle"));
    assert.equal(rows().length, 3);
    assert.equal(reorderProject(workspace, "z", "empty", false), workspace);
    assert.equal(reorderProject(workspace, "z", "p", false), workspace);
    const reordered = reorderProject(workspace, "a", "z", false);
    assert.ok(
      reordered.projects.findIndex((p) => p.id === "a") <
        reordered.projects.findIndex((p) => p.id === "z"),
    );
    workspace = removeSession(workspace, "pinned");
    await render();
    assert.ok(document.querySelector('section[aria-label="Pinned"] [data-project-id="p"]'));
    workspace = removeSession(workspace, "alpha");
    await render();
    assert.deepEqual(names(), ["Zulu"]);
    assert.ok(document.querySelector('section[aria-label="Projects"] [data-project-id="a"]'));
    workspace = {
      ...workspace,
      projects: workspace.projects.map((p) =>
        p.id === "a" ? { ...p, sessions: [session("new")] } : p,
      ),
    };
    await render();
    assert.deepEqual(names(), ["Zulu", "Alpha"]);
    localStorage.setItem(
      settingsKey,
      JSON.stringify({ ...defaults, language: "en", projectOrder: "name" }),
    );
    providerKey++;
    await render();
    assert.deepEqual(names(), ["Alpha", "Zulu"]);
    await click(toggle("Zulu"));
    await render();
    for (const id of ["wt", "shell", "agent"]) workspace = removeSession(workspace, id);
    await render();
    assert.equal(document.querySelectorAll('[data-project-id="z"]').length, 1);
    assert.equal(
      projectRow("z").querySelector(".folder-toggle").getAttribute("aria-expanded"),
      "false",
    );
    assert.match(document.querySelector('section[aria-label="Pinned"]').textContent, /Tree/);
    workspace = {
      ...workspace,
      projects: workspace.projects.map((p) =>
        p.id === "z" ? { ...p, sessions: [session("wt-again", { worktreeId: "tree" })] } : p,
      ),
    };
    await render();
    assert.equal(toggle("Zulu").getAttribute("aria-expanded"), "true");
    assert.equal(toggle("Tree").getAttribute("aria-expanded"), "true");
    workspace = moveProject(workspace, "z", "other");
    await render();
    assert.deepEqual(names(), ["Alpha"]);
    workspace = { ...workspace, selectedWorkspace: "other" };
    await render();
    assert.deepEqual(names(), ["Elsewhere", "Zulu"]);
    await act(async () => setUiLanguage("zh-Hans"));
    assert.ok(document.querySelector('section[aria-label="活动"] .session-row'));
    workspace = { ...workspace, selectedWorkspace: local, projects: [] };
    await render();
    assert.equal(document.querySelector('section[aria-label="活动"]'), null);
    assert.ok(document.querySelector('section[aria-label="独立终端"]'));
    assert.ok(document.querySelector('section[aria-label="聊天"]'));
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
