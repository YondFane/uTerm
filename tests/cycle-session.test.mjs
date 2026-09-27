import test from "node:test";
import assert from "node:assert/strict";
import { readWorkspace, createWorkspaceGroup, cycleSession } from "../src/lib/workspace.ts";

test("session cycling crosses workspaces, skips empty groups and wraps both ways", () => {
  const base = readWorkspace(null);
  const workspace = {
    ...base,
    selectedProject: "a",
    selectedSession: "a1",
    groups: [
      { ...base.groups[0], terminals: [{ id: "terminal" }] },
      createWorkspaceGroup("empty", "Empty"),
      { ...createWorkspaceGroup("b", "B"), chats: [{ id: "chat" }] },
    ],
    projects: [
      { id: "a", workspaceId: base.selectedWorkspace, sessions: [{ id: "a1" }] },
      { id: "b", workspaceId: "b", sessions: [{ id: "b1", worktreeId: "wt" }] },
    ],
  };
  let state = workspace;
  const ids = [];
  for (let i = 0; i < 4; i++) {
    state = cycleSession(state, 1);
    ids.push(state.selectedSession);
  }
  assert.deepEqual(ids, ["terminal", "b1", "chat", "a1"]);
  const previous = cycleSession(workspace, -1);
  assert.equal(previous.selectedSession, "chat");
  assert.equal(previous.selectedWorkspace, "b");
  assert.equal(previous.selectedProject, null);
  assert.equal(previous.groups[0].selectedSession, "a1");
  const worktree = cycleSession(previous, -1);
  assert.equal(worktree.selectedSession, "b1");
  assert.equal(worktree.selectedProject, "b");
  assert.equal(worktree.selectedWorktree, "wt");
  assert.equal(cycleSession({ ...workspace, selectedSession: null }, 1).selectedSession, "a1");
  assert.equal(
    cycleSession({ ...workspace, selectedSession: null }, -1).selectedSession,
    "terminal",
  );
  assert.equal(cycleSession(base, 1), base);
  assert.equal(cycleSession(base, -1), base);
});
