import { test } from "node:test";
import assert from "node:assert/strict";
import {
  moveSessionPane,
  createWorkspaceGroup,
  readWorkspace,
  groupSessions,
  ungroupSession,
  removeSession,
  splitGroup,
  leaves,
  paneLayout,
  neighborPane,
  resizeSplit,
  moveProject,
  switchWorkspace,
} from "../src/lib/workspace.ts";

function fixture() {
  return readWorkspace(
    JSON.stringify({
      version: 3,
      groups: [createWorkspaceGroup("local", "Local")],
      selectedWorkspace: "local",
      projects: [
        {
          id: "project",
          name: "项目",
          directory: "/tmp/中文 项目",
          workspaceId: "local",
          sessions: ["a", "b", "c", "d"].map((id) => ({ id, name: id, shell: "default" })),
        },
        {
          id: "other",
          name: "其他",
          directory: "/tmp",
          workspaceId: "local",
          sessions: [{ id: "e", name: "e", shell: "default" }],
        },
      ],
      selectedProject: "project",
      selectedSession: "a",
    }),
  );
}
const group = (state) => splitGroup(state.projects[0], state.selectedSession);

test("grouping reuses sessions and alternates nested axes", () => {
  const original = fixture();
  let state = groupSessions(original, "b", "a");
  state = groupSessions(state, "c", "b");
  assert.deepEqual(state.projects[0].sessions, original.projects[0].sessions);
  assert.equal(group(state).axis, "horizontal");
  assert.equal(group(state).second.axis, "vertical");
  assert.deepEqual(leaves(group(state)), ["a", "b", "c"]);
  assert.deepEqual(paneLayout(group(state)).panes.c, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
});
test("grouping rejects self, cross-project and duplicate membership", () => {
  const state = groupSessions(fixture(), "b", "a");
  for (const [moved, anchor] of [
    ["a", "a"],
    ["e", "a"],
    ["missing", "a"],
    ["b", "a"],
  ])
    assert.equal(groupSessions(state, moved, anchor), state);
});
test("moving a pane between groups collapses its previous tree without losing sessions", () => {
  let state = groupSessions(groupSessions(fixture(), "b", "a"), "d", "c");
  state = groupSessions(state, "b", "c");
  assert.equal(state.projects[0].splitGroups.length, 1);
  assert.deepEqual(leaves(group(state)), ["c", "b", "d"]);
  assert.equal(splitGroup(state.projects[0], "a"), undefined);
  assert.equal(state.projects[0].sessions.length, 4);
});
test("ungrouping preserves session configuration and follows the detached session", () => {
  const state = groupSessions(groupSessions(fixture(), "b", "a"), "c", "b");
  const detached = ungroupSession(state, "b");
  assert.deepEqual(detached.projects[0].sessions, state.projects[0].sessions);
  assert.equal(detached.selectedSession, "b");
  assert.deepEqual(leaves(detached.projects[0].splitGroups[0]), ["a", "c"]);
  assert.equal(ungroupSession(detached, "c").projects[0].splitGroups.length, 0);
});
test("closing the selected pane stays in its group, not an unrelated sidebar neighbor", () => {
  let state = groupSessions(fixture(), "d", "a");
  state = removeSession(state, "d");
  assert.equal(state.selectedSession, "a");
  assert.equal(state.projects[0].splitGroups.length, 0);
  assert.deepEqual(
    state.projects[0].sessions.map((session) => session.id),
    ["a", "b", "c"],
  );
});
test("closing a background pane preserves selection and removes only its leaf", () => {
  const state = groupSessions(groupSessions(fixture(), "b", "a"), "c", "b");
  const next = removeSession(state, "b");
  assert.equal(next.selectedSession, "c");
  assert.deepEqual(leaves(group(next)), ["a", "c"]);
  assert.deepEqual(next.projects[1], state.projects[1]);
});
test("directional focus uses geometry across unequal nested panes and does not wrap", () => {
  let state = groupSessions(groupSessions(fixture(), "b", "a"), "c", "b");
  state = resizeSplit(state, "project", group(state).id, 0.3);
  const root = group(state);
  assert.equal(neighborPane(root, "b", "down"), "c");
  assert.equal(neighborPane(root, "c", "up"), "b");
  assert.equal(neighborPane(root, "c", "left"), "a");
  assert.equal(neighborPane(root, "a", "left"), null);
  assert.equal(neighborPane(root, "c", "down"), null);
});
test("layout ratios and selection survive serialization and moving a whole project", () => {
  let state = groupSessions(fixture(), "b", "a", "vertical");
  state = resizeSplit(state, "project", group(state).id, 0.68);
  state.groups.push(createWorkspaceGroup("second", "Second"));
  state = switchWorkspace(moveProject(state, "project", "second"), "second");
  const restored = readWorkspace(JSON.stringify(state));
  assert.deepEqual(restored, state);
  assert.equal(restored.projects[0].splitGroups[0].ratio, 0.68);
});
test("ratios are bounded and malformed saved trees are rejected", () => {
  const original = groupSessions(fixture(), "b", "a");
  assert.equal(group(resizeSplit(original, "project", group(original).id, 100)).ratio, 0.85);
  assert.equal(group(resizeSplit(original, "project", group(original).id, -1)).ratio, 0.15);
  for (const corrupt of [
    (node) => {
      node.second.session = "missing";
    },
    (node) => {
      node.second.session = "a";
    },
    (node) => {
      node.axis = "diagonal";
    },
    (node) => {
      node.ratio = null;
    },
    (node) => {
      node.first = null;
    },
  ]) {
    const state = structuredClone(original);
    corrupt(group(state));
    assert.throws(() => readWorkspace(JSON.stringify(state)));
  }
  const duplicate = structuredClone(original);
  duplicate.projects[0].splitGroups.push(group(duplicate));
  assert.throws(() => readWorkspace(JSON.stringify(duplicate)));
});
test("sessions without a split layout remain standalone", () => {
  const state = fixture();
  assert.deepEqual(state.projects[0].splitGroups, []);
  assert.equal(state.selectedSession, "a");
});

test("closing a nested focused pane chooses its sibling before a distant pane", () => {
  const state = groupSessions(groupSessions(fixture(), "b", "a"), "c", "b");
  assert.equal(removeSession(state, "c").selectedSession, "b");
});

test("dropping an existing pane on each edge reorders it without replacing sessions", () => {
  const original = groupSessions(fixture(), "b", "a");
  for (const edge of ["left", "right", "top", "bottom"]) {
    const next = moveSessionPane(original, "b", "a", edge);
    assert.deepEqual(next.projects[0].sessions, original.projects[0].sessions);
    assert.deepEqual(leaves(group(next)), ["left", "top"].includes(edge) ? ["b", "a"] : ["a", "b"]);
    assert.equal(group(next).axis, ["left", "right"].includes(edge) ? "horizontal" : "vertical");
    assert.deepEqual(readWorkspace(JSON.stringify(next)), next);
  }
  assert.equal(moveSessionPane(original, "e", "a", "left"), original);
  assert.equal(moveSessionPane(original, "a", "a", "left"), original);
});
