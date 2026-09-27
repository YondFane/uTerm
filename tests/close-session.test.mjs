import test from "node:test";
import assert from "node:assert/strict";
import { readWorkspace, nextSessionToClose, removeSession } from "../src/lib/workspace.ts";

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
