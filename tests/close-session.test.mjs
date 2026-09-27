import test from "node:test";
import assert from "node:assert/strict";
import {
  readWorkspace,
  nextSessionToClose,
  removeSession,
  createWorkspaceGroup,
  selectSession,
  switchWorkspace,
  sessionRosters,
} from "../src/lib/workspace.ts";

test("close prioritizes selected project then drains all projects and loose sessions", () => {
  const base = readWorkspace(null);
  let workspace = {
    ...base,
    selectedProject: "b",
    selectedSession: "b2",
    projects: [
      { id: "a", workspaceId: base.selectedWorkspace, sessions: [{ id: "a1" }] },
      { id: "b", workspaceId: base.selectedWorkspace, sessions: [{ id: "b1" }, { id: "b2" }] },
      { id: "c", workspaceId: "other", sessions: [{ id: "c1" }] },
    ],
    groups: base.groups.map((group) => ({ ...group, terminals: [{ id: "loose" }] })),
  };
  const closed = [];
  while (nextSessionToClose(workspace)) {
    const id = nextSessionToClose(workspace);
    closed.push(id);
    workspace = removeSession(workspace, id);
  }
  assert.deepEqual(closed, ["b2", "b1", "a1", "c1", "loose"]);
});

test("close switches to background workspaces and drains project, worktree and loose sessions", () => {
  const base = readWorkspace(null);
  let workspace = {
    ...base,
    groups: [
      ...base.groups,
      {
        ...createWorkspaceGroup("other", "Other"),
        terminals: [{ id: "terminal" }],
        chats: [{ id: "chat" }],
      },
    ],
    projects: [
      {
        id: "project",
        workspaceId: "other",
        sessions: [{ id: "project-session" }, { id: "worktree-session", worktreeId: "wt" }],
      },
    ],
  };
  const closed = [];
  while (nextSessionToClose(workspace)) {
    const id = nextSessionToClose(workspace);
    const roster = sessionRosters(workspace).find((item) =>
      item.sessions.some((session) => session.id === id),
    );
    workspace = selectSession(switchWorkspace(workspace, roster.workspaceId), id);
    assert.equal(workspace.selectedWorkspace, "other");
    assert.equal(workspace.selectedSession, id);
    assert.equal(nextSessionToClose(workspace), id, "A failed close keeps the same retry target");
    if (id === "worktree-session") assert.equal(workspace.selectedWorktree, "wt");
    closed.push(id);
    workspace = removeSession(workspace, id);
  }
  assert.deepEqual(closed, ["project-session", "worktree-session", "terminal", "chat"]);
  assert.equal(nextSessionToClose(workspace), undefined);
});
