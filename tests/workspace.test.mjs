import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceGroup,
  canRemoveWorkspace,
  removeWorkspace,
  readWorkspace,
  removeSession,
  selectProject,
  switchWorkspace,
  moveProject,
  reorder,
  ordered,
  reconcileLocalSessions,
  reconcileLocalSessionSnapshot,
} from "../src/lib/workspace.ts";
test("workspace deletion protects contents and the last workspace", () => {
  const base = readWorkspace(null);
  const id = base.selectedWorkspace;
  assert.equal(canRemoveWorkspace(base, id), false);
  const next = { ...base, groups: [...base.groups, createWorkspaceGroup("other", "Other")] };
  assert.equal(canRemoveWorkspace(next, id), true);
  const removed = removeWorkspace(next, id);
  assert.equal(removed.selectedWorkspace, "other");
  assert.equal(removed.groups.length, 1);
  assert.equal(removed.selectedSession, null);
  assert.equal(removeWorkspace(next, "missing"), next);
  const populated = { ...next, projects: [{ id: "p", workspaceId: id, sessions: [] }] };
  assert.equal(removeWorkspace(populated, id), populated);
  for (const kind of ["terminals", "chats"]) {
    const busy = {
      ...next,
      groups: next.groups.map((group) =>
        group.id === id ? { ...group, [kind]: [{ id: "s" }] } : group,
      ),
    };
    assert.equal(removeWorkspace(busy, id), busy);
  }
  const backgroundRemoved = removeWorkspace(next, "other");
  assert.equal(backgroundRemoved.selectedWorkspace, id);
});
const fixture = () => ({
  version: 3,
  groups: [createWorkspaceGroup("local", "Local")],
  selectedWorkspace: "local",
  projects: [
    {
      id: "p1",
      name: "项目",
      directory: "/tmp/project with spaces",
      workspaceId: "local",
      sessions: [
        { id: "s1", name: "终端 1", shell: "default" },
        { id: "s2", name: "终端 2", shell: "cmd" },
      ],
    },
    {
      id: "p2",
      name: "另一个项目",
      directory: "C:\\项目",
      workspaceId: "local",
      sessions: [{ id: "s3", name: "终端 1", shell: "default" }],
    },
  ],
  selectedProject: "p1",
  selectedSession: "s2",
});

test("explicit host closes remove their local records", () => {
  const workspace = readWorkspace(JSON.stringify(fixture()));
  assert.equal(reconcileLocalSessionSnapshot(workspace, { sessions: [], closed: [] }), workspace);
  const next = reconcileLocalSessionSnapshot(workspace, {
    sessions: [{ id: "s2", directory: workspace.projects[0].directory, shell: "cmd", agent: null }],
    closed: ["s2", "s3"],
  });
  assert.deepEqual(
    next.projects[0].sessions.map((session) => session.id),
    ["s1"],
  );
  assert.equal(next.selectedSession, "s1");
  assert.equal(next.projects[1].sessions.length, 0);
  assert.equal(reconcileLocalSessionSnapshot(next, { sessions: [], closed: ["s2"] }), next);
});

test("explicit closes remove loose background chats without changing an unrelated selection", () => {
  const workspace = readWorkspace(JSON.stringify(fixture()));
  const added = reconcileLocalSessions(workspace, [
    { id: "background", directory: "/loose", shell: "default", agent: "codex" },
  ]);
  const next = reconcileLocalSessionSnapshot(added, { sessions: [], closed: ["background"] });
  assert.equal(next.groups[0].chats.length, 0);
  assert.equal(next.selectedSession, workspace.selectedSession);
  assert.deepEqual(readWorkspace(JSON.stringify(next)), next);
});

test("host discovery imports once without changing selection or saved session metadata", () => {
  const workspace = readWorkspace(JSON.stringify(fixture()));
  const discovered = [
    { id: "background", directory: "/tmp/project with spaces", shell: "default", agent: "codex" },
  ];
  const next = reconcileLocalSessions(workspace, discovered);
  assert.equal(next.projects[0].sessions.at(-1).id, "background");
  assert.equal(next.selectedSession, workspace.selectedSession);
  assert.equal(next.selectedProject, workspace.selectedProject);
  assert.equal(reconcileLocalSessions(next, discovered), next);
  assert.equal(reconcileLocalSessions(next, []), next);
  assert.deepEqual(readWorkspace(JSON.stringify(next)), next);
  assert.equal(workspace.projects[0].sessions.length, 2);
});

test("host discovery matches Windows verbatim paths and worktrees across workspaces", () => {
  const workspace = readWorkspace(JSON.stringify(fixture()));
  workspace.projects[1].worktrees = [
    { id: "tree", name: "tree", path: "D:\\Code\\Tree", branch: "feature" },
  ];
  const next = reconcileLocalSessions(workspace, [
    { id: "phone", directory: "\\\\?\\d:\\code\\tree\\", shell: "default", agent: "claude" },
    { id: "phone2", directory: "\\\\?\\C:\\项目", shell: "cmd", agent: null },
  ]);
  assert.equal(next.projects[1].sessions.at(-2).worktreeId, "tree");
  assert.equal(next.projects[1].sessions.at(-1).shell, "cmd");
  assert.equal(next.projects[0].sessions.length, 2);
});

test("unmatched host sessions become loose sessions and existing IDs are never overwritten", () => {
  const workspace = readWorkspace(JSON.stringify(fixture()));
  const next = reconcileLocalSessions(workspace, [
    { id: "s1", directory: "/elsewhere", shell: "cmd", agent: "codex" },
    { id: "chat", directory: "/new/project", shell: "default", agent: "codex" },
    { id: "terminal", directory: "/new/project", shell: "default", agent: null },
  ]);
  assert.equal(next.projects, workspace.projects);
  assert.equal(next.groups[0].chats[0].id, "chat");
  assert.equal(next.groups[0].terminals[0].id, "terminal");
  assert.deepEqual(readWorkspace(JSON.stringify(next)), next);
});
test("restores selection, Unicode paths, and shell settings without runtime data", () => {
  const saved = fixture();
  saved.projects[0].sessions[0].pid = 123;
  assert.throws(() => readWorkspace(JSON.stringify(saved)));
  delete saved.projects[0].sessions[0].pid;
  const restored = readWorkspace(JSON.stringify(saved));
  assert.equal(restored.version, 3);
  assert.equal(restored.selectedSession, "s2");
  assert.equal(restored.projects[0].workspaceId, "local");
  assert.equal(restored.projects[0].sessions[0].pid, undefined);
  assert.equal(restored.projects[0].directory, saved.projects[0].directory);
  assert.equal(restored.projects[0].sessions[1].shell, "cmd");
});
test("closing current session selects its neighbor without touching other projects", () => {
  const result = removeSession(fixture(), "s2");
  assert.equal(result.selectedSession, "s1");
  assert.equal(result.projects[1].sessions[0].id, "s3");
  assert.equal(removeSession(result, "s1").selectedSession, null);
});
test("closing a background session preserves foreground selection", () => {
  assert.equal(removeSession(fixture(), "s3").selectedSession, "s2");
});
test("project switching updates both selections and does not remove sessions", () => {
  const switched = selectProject(fixture(), "p2");
  assert.equal(switched.selectedSession, "s3");
  assert.deepEqual(switched.projects, fixture().projects);
});
test("invalid selection falls back to a session in the selected project", () => {
  const saved = fixture();
  saved.selectedSession = "s3";
  assert.equal(readWorkspace(JSON.stringify(saved)).selectedSession, "s1");
});
test("rejects broken, unsupported, and duplicate configurations instead of overwriting", () => {
  assert.throws(() => readWorkspace("{"));
  assert.throws(() => readWorkspace(JSON.stringify({ ...fixture(), version: 2 })));
  const duplicate = fixture();
  duplicate.projects[1].sessions[0].id = "s1";
  assert.throws(() => readWorkspace(JSON.stringify(duplicate)));
  const invalidShell = fixture();
  invalidShell.projects[0].sessions[0].shell = "arbitrary-command";
  assert.throws(() => readWorkspace(JSON.stringify(invalidShell)));
});

test("switching workspaces remembers selection and retains all sessions", () => {
  let state = readWorkspace(JSON.stringify(fixture()));
  state.groups.push(createWorkspaceGroup("other", "其他"));
  state = moveProject(state, "p2", "other");
  const other = switchWorkspace(state, "other");
  assert.equal(other.selectedProject, "p2");
  assert.equal(other.selectedSession, "s3");
  const back = switchWorkspace(other, "local");
  assert.equal(back.selectedSession, "s2");
  assert.deepEqual(back.projects, state.projects);
  assert.deepEqual(readWorkspace(JSON.stringify(back)), back);
});
test("moving selected project chooses a remaining local project, preserving session identity", () => {
  const state = readWorkspace(JSON.stringify(fixture()));
  state.groups.push(createWorkspaceGroup("other", "其他"));
  const moved = moveProject(state, "p1", "other");
  assert.equal(moved.selectedProject, "p2");
  assert.equal(moved.selectedSession, "s3");
  assert.deepEqual(moved.projects[0].sessions, state.projects[0].sessions);
});
test("reorder stays within pinned peers and preserves every item", () => {
  const items = [{ id: "a" }, { id: "p", pinned: true }, { id: "b" }];
  assert.deepEqual(
    ordered(reorder(items, "b", -1)).map((item) => item.id),
    ["p", "b", "a"],
  );
  assert.deepEqual(reorder(items, "a", -1), items);
});
test("unknown workspace references and duplicate group identifiers are rejected", () => {
  const state = readWorkspace(JSON.stringify(fixture()));
  state.projects[0].workspaceId = "missing";
  assert.throws(() => readWorkspace(JSON.stringify(state)));
  state.projects[0].workspaceId = "local";
  state.groups.push({ ...state.groups[0] });
  assert.throws(() => readWorkspace(JSON.stringify(state)));
});

test("GitHub association survives persistence and rejects unrelated URLs", () => {
  const saved = fixture();
  saved.projects[0].sessions[0].issue = {
    url: "https://github.com/owner/repo/issues/12",
    title: "Issue 12",
  };
  assert.deepEqual(
    readWorkspace(JSON.stringify(saved)).projects[0].sessions[0].issue,
    saved.projects[0].sessions[0].issue,
  );
  for (const url of [
    "javascript:alert(1)",
    "https://github.com.evil/owner/repo/issues/12",
    "https://github.com/owner/repo/issues/12?command=run",
  ]) {
    saved.projects[0].sessions[0].issue.url = url;
    assert.throws(() => readWorkspace(JSON.stringify(saved)));
  }
});
