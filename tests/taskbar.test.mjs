import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskbarSnapshot, taskbarSnapshotSignature } from "../src/lib/taskbar.ts";
import { createWorkspaceGroup, emptyWorkspace } from "../src/lib/workspace.ts";

function fixture() {
  const workspace = emptyWorkspace();
  const local = workspace.groups[0];
  local.name = "Local";
  local.terminals = [
    { id: "plain", name: "Terminal", shell: "default" },
    { id: "detected", name: "Detected Codex", shell: "default" },
  ];
  local.chats = [
    { id: "idle", name: "Idle", shell: "default", agent: "codex" },
    { id: "done", name: "Done", shell: "default", agent: "claude" },
  ];
  const other = createWorkspaceGroup("other", "Other");
  workspace.groups.push(other);
  workspace.projects = [
    {
      id: "project",
      name: "Project & tools",
      directory: "/tmp/project",
      workspaceId: "other",
      sessions: [
        { id: "working", name: "Working", shell: "default", agent: "codex" },
        { id: "waiting", name: "Waiting", shell: "default", agent: "claude" },
        { id: "error", name: "Error", shell: "default", agent: "gemini" },
      ],
    },
  ];
  return workspace;
}

test("taskbar includes active configured and detected agents across workspaces", () => {
  const snapshot = buildTaskbarSnapshot(
    fixture(),
    {
      plain: "idle",
      idle: "idle",
      done: "done",
      working: "working",
      waiting: "waiting",
      error: "error",
    },
    { detected: "codex" },
    "en",
  );
  assert.equal(snapshot.status, "attention");
  assert.deepEqual(
    snapshot.groups.map((group) => [
      group.title,
      group.tasks.map((task) => `${task.state}:${task.id}`),
    ]),
    [
      ["Local — Terminal", ["working:detected"]],
      ["Local — Agent chats", ["done:done"]],
      ["Other — Project & tools", ["waiting:waiting", "error:error", "working:working"]],
    ],
  );
});

test("taskbar retains a reported dynamic-agent result after process detection ends", () => {
  const workspace = fixture();
  const snapshot = buildTaskbarSnapshot(workspace, { detected: "error" }, {}, "en");
  assert.deepEqual(snapshot.groups, [
    {
      title: "Local — Terminal",
      tasks: [{ id: "detected", title: "Detected Codex", state: "error" }],
    },
  ]);
});

test("taskbar aggregates done before working and has a stable empty snapshot", () => {
  const workspace = fixture();
  const working = buildTaskbarSnapshot(
    workspace,
    { done: "done", working: "working" },
    {},
    "zh-Hans",
  );
  assert.equal(working.status, "done");
  const empty = buildTaskbarSnapshot(workspace, { idle: "idle" }, {}, "zh-Hans");
  assert.equal(empty.status, "idle");
  assert.deepEqual(empty.groups, []);
  assert.equal(
    taskbarSnapshotSignature(empty),
    taskbarSnapshotSignature(buildTaskbarSnapshot(workspace, { idle: "idle" }, {}, "zh-Hans")),
  );
  assert.notEqual(taskbarSnapshotSignature(empty), taskbarSnapshotSignature(working));
});

test("taskbar only highlights completions that have not been viewed", () => {
  const workspace = fixture();
  const viewed = buildTaskbarSnapshot(workspace, { done: "done" }, {}, "en", undefined, new Set());
  const unread = buildTaskbarSnapshot(
    workspace,
    { done: "done" },
    {},
    "en",
    undefined,
    new Set(["done"]),
  );
  assert.equal(viewed.status, "idle");
  assert.deepEqual(viewed.groups, []);
  assert.equal(unread.status, "done");
  assert.deepEqual(unread.groups[0].tasks, [{ id: "done", title: "Done", state: "done" }]);
});
