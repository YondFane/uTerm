import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceGroup,
  readWorkspace,
  selectProject,
  selectSession,
  switchWorkspace,
  sessionEntries,
  sessionRosters,
  selectedRoster,
  groupSessions,
  groupableSessions,
  removeSession,
  splitGroup,
  leaves,
  reconcileWorktrees,
  moveProject,
  removeProject,
  reorderProject,
} from "../src/lib/workspace.ts";
function fixture() {
  const group = createWorkspaceGroup("local", "本地");
  group.terminals = [
    { id: "loose1", name: "终端 1", shell: "default", directory: "/home/person" },
    { id: "loose2", name: "终端 2", shell: "default", directory: "/home/person" },
  ];
  group.chats = [
    { id: "chat", name: "Codex", shell: "default", directory: "/app/chats", agent: "codex" },
  ];
  return readWorkspace(
    JSON.stringify({
      version: 3,
      selectedWorkspace: "local",
      groups: [group, createWorkspaceGroup("other", "其他")],
      selectedProject: "p",
      selectedSession: "root",
      projects: [
        {
          id: "p",
          name: "Project",
          directory: "/tmp/root",
          workspaceId: "local",
          worktrees: [{ id: "tree", name: "feature", path: "/tmp/中文 tree", branch: "feature" }],
          sessions: [
            { id: "root", name: "Root", shell: "default" },
            { id: "branch1", name: "Branch 1", shell: "default", worktreeId: "tree" },
            { id: "branch2", name: "Branch 2", shell: "default", worktreeId: "tree" },
          ],
        },
      ],
    }),
  );
}
test("unsupported workspace schemas are rejected", () => {
  const source = fixture();
  source.version = 2;
  assert.throws(() => readWorkspace(JSON.stringify(source)));
});
test("unrecognized session fields are rejected without changing the input", () => {
  const source = fixture();
  source.projects[0].sessions[0].connection = "unsupported";
  const serialized = JSON.stringify(source);
  assert.throws(() => readWorkspace(serialized));
  assert.equal(JSON.stringify(source), serialized);
});
test("project root and Worktree selections have distinct rosters and correct launch paths", () => {
  const state = selectProject(fixture(), "p", "tree");
  assert.equal(state.selectedSession, "branch1");
  assert.equal(selectProject(state, "p").selectedSession, "root");
  assert.equal(
    sessionEntries(state).find((entry) => entry.session.id === "branch1").directory,
    "/tmp/中文 tree",
  );
  assert.equal(
    sessionEntries(state).find((entry) => entry.session.id === "chat").directory,
    "/app/chats",
  );
});
test("loose sessions retain selection across workspace switches and reloads", () => {
  const selected = selectSession(fixture(), "chat");
  const restored = readWorkspace(
    JSON.stringify(switchWorkspace(switchWorkspace(selected, "other"), "local")),
  );
  assert.equal(restored.selectedProject, null);
  assert.equal(restored.selectedSession, "chat");
  assert.equal(selectedRoster(restored).kind, "chats");
  assert.equal(restored.groups[0].chats[0].agent, "codex");
});
test("grouping cannot cross project roots, Worktrees, loose terminals or chats", () => {
  const state = fixture();
  for (const [a, b] of [
    ["branch1", "root"],
    ["loose1", "root"],
    ["chat", "loose1"],
  ])
    assert.equal(groupSessions(state, a, b), state);
  assert.deepEqual(
    groupableSessions(state, "branch1").map((session) => session.id),
    ["branch2"],
  );
  const grouped = groupSessions(state, "loose2", "loose1");
  assert.deepEqual(leaves(splitGroup(selectedRoster(grouped), "loose1")), ["loose1", "loose2"]);
  assert.deepEqual(readWorkspace(JSON.stringify(grouped)), grouped);
});
test("closing a loose session updates only its owning workspace collection", () => {
  const state = selectSession(fixture(), "chat");
  const next = removeSession(state, "chat");
  assert.equal(next.selectedSession, null);
  assert.equal(next.groups[0].chats.length, 0);
  assert.deepEqual(next.projects, state.projects);
  assert.deepEqual(next.groups[0].terminals, state.groups[0].terminals);
});
test("Worktree discovery preserves names, pins, ordering and missing-session access", () => {
  const state = fixture();
  state.projects[0].worktrees[0].pinned = true;
  state.projects[0].worktrees[0].name = "我的分支";
  const discovered = reconcileWorktrees(state, "p", [
    { path: "/tmp/中文 tree", branch: "renamed-branch", missing: false },
  ]);
  assert.equal(discovered.projects[0].worktrees[0].id, "tree");
  assert.equal(discovered.projects[0].worktrees[0].name, "我的分支");
  assert.equal(discovered.projects[0].worktrees[0].pinned, true);
  const missing = reconcileWorktrees(discovered, "p", []);
  assert.equal(missing.projects[0].worktrees[0].missing, true);
  assert.equal(
    sessionEntries(missing).find((entry) => entry.session.id === "branch1").directory,
    "/tmp/中文 tree",
  );
});
test("deleted Worktrees without sessions are removed from the workspace", () => {
  const state = fixture();
  state.projects[0].sessions = state.projects[0].sessions.filter(
    (session) => session.worktreeId === undefined,
  );
  const removed = reconcileWorktrees(state, "p", []);
  assert.deepEqual(removed.projects[0].worktrees, []);
});
test("moving a project preserves its Worktrees without moving loose sessions", () => {
  const state = fixture();
  const moved = moveProject(selectSession(state, "loose1"), "p", "other");
  assert.equal(moved.selectedSession, "loose1");
  assert.deepEqual(moved.projects[0].worktrees, state.projects[0].worktrees);
  assert.equal(
    sessionRosters(moved).find((roster) => roster.projectId === "p").workspaceId,
    "other",
  );
});
test("invalid Worktree references, duplicate loose IDs and chats without agents are rejected", () => {
  for (const corrupt of [
    (state) => {
      state.projects[0].sessions[1].worktreeId = "missing";
    },
    (state) => {
      state.groups[0].chats[0].id = "root";
    },
    (state) => {
      delete state.groups[0].chats[0].agent;
    },
    (state) => {
      delete state.groups[0].terminals[0].directory;
    },
  ]) {
    const state = fixture();
    corrupt(state);
    assert.throws(() => readWorkspace(JSON.stringify(state)));
  }
});

test("project drag preserves sessions and selection, persists order and respects section boundaries", () => {
  const state = fixture();
  const project = state.projects[0];
  state.projects.push(
    {
      ...project,
      id: "second",
      sessions: [{ id: "second-session", name: "Terminal", shell: "default" }],
      worktrees: [],
      splitGroups: [],
    },
    {
      ...project,
      id: "third",
      sessions: [{ id: "third-session", name: "Terminal", shell: "default" }],
      worktrees: [],
      splitGroups: [],
    },
    { ...project, id: "pinned", pinned: true, sessions: [], worktrees: [] },
    { ...project, id: "elsewhere", workspaceId: "other", sessions: [], worktrees: [] },
  );
  const moved = reorderProject(state, "p", "third", true);
  assert.deepEqual(
    moved.projects.map((item) => item.id),
    ["second", "third", "p", "pinned", "elsewhere"],
  );
  assert.equal(moved.selectedSession, state.selectedSession);
  assert.equal(moved.projects[2], project);
  assert.deepEqual(
    readWorkspace(JSON.stringify(moved)).projects.map((item) => item.id),
    moved.projects.map((item) => item.id),
  );
  assert.equal(reorderProject(state, "p", "pinned", false), state);
  assert.equal(reorderProject(state, "p", "elsewhere", false), state);
  assert.equal(reorderProject(state, "missing", "p", false), state);
  assert.equal(reorderProject(state, "p", "p", false), state);
  assert.equal(reorderProject(moved, "p", "second", false).projects[0].id, "p");
});
test("project removal requires closing sessions and normalizes selection", () => {
  const state = fixture();
  assert.equal(removeProject(state, "p"), state);
  const empty = { ...state, projects: [{ ...state.projects[0], sessions: [] }] };
  const removed = removeProject(empty, "p");
  assert.equal(removed.projects.length, 0);
  assert.equal(removed.selectedProject, null);
  assert.equal(removed.selectedWorktree, null);
  assert.equal(readWorkspace(JSON.stringify(removed)).projects.length, 0);
  assert.equal(removeProject(state, "missing"), state);
});
