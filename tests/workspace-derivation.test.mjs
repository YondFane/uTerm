import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceGroup,
  emptyWorkspace,
  selectedRoster,
  sessionEntries,
  sessionRosters,
} from "../src/lib/workspace.ts";

const session = (id, extra = {}) => ({ id, name: id, shell: "default", ...extra });

function fixture() {
  return {
    ...emptyWorkspace(),
    selectedWorkspace: "local",
    selectedProject: "p",
    selectedSession: "root",
    projects: [
      {
        id: "p",
        name: "Project",
        directory: "/project/中文",
        worktrees: [{ id: "tree", name: "Tree", path: "/tree path", branch: "feature" }],
        sessions: [
          session("root"),
          session("tree", { worktreeId: "tree" }),
          session("override", { worktreeId: "tree", directory: "/override" }),
          session("empty", { directory: "" }),
          session("missing", { worktreeId: "missing" }),
        ],
      },
      { id: "empty", name: "Empty", directory: "/empty", sessions: [] },
      {
        id: "other",
        name: "Other",
        workspaceId: "other",
        directory: "C:\\project",
        sessions: [session("other")],
      },
    ],
    groups: [
      {
        ...createWorkspaceGroup("local", "Local"),
        sshConnections: [
          {
            id: "ssh",
            name: "SSH",
            sessions: [session("ssh"), session("ssh-path", { directory: "/ssh" })],
          },
        ],
        terminals: [session("terminal", { directory: "/home" })],
        chats: [session("chat", { agent: "codex" })],
      },
      { ...createWorkspaceGroup("other", "Other"), terminals: [session("other-loose")] },
    ],
  };
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("session entries preserve source order, identity and directory precedence without mutation", () => {
  const state = freeze(fixture());
  const entries = sessionEntries(state);
  assert.deepEqual(
    entries.map(({ session, directory }) => [session.id, directory]),
    [
      ["root", "/project/中文"],
      ["tree", "/tree path"],
      ["override", "/override"],
      ["empty", ""],
      ["missing", "/project/中文"],
      ["other", "C:\\project"],
      ["ssh", ""],
      ["ssh-path", "/ssh"],
      ["terminal", "/home"],
      ["chat", ""],
      ["other-loose", ""],
    ],
  );
  const source = sessionRosters(state).flatMap((roster) => roster.sessions);
  entries.forEach((entry, index) => assert.equal(entry.session, source[index]));
  assert.deepEqual(sessionEntries({ ...state, projects: [], groups: undefined }), []);
});

test("selected roster matches the ordered rosters for all session and project selections", () => {
  const state = freeze(fixture());
  const rosters = sessionRosters(state);
  for (const workspaceId of ["local", "other", "missing", undefined]) {
    for (const selectedSession of [
      null,
      "missing-session",
      ...sessionEntries(state).map((entry) => entry.session.id),
    ]) {
      for (const selectedProject of [null, "p", "other", "missing-project"]) {
        const next = { ...state, selectedWorkspace: workspaceId, selectedProject, selectedSession };
        const expected = rosters.find(
          (roster) =>
            roster.workspaceId === workspaceId &&
            (selectedSession
              ? roster.sessions.some((session) => session.id === selectedSession)
              : roster.projectId !== null && roster.projectId === selectedProject),
        );
        assert.deepEqual(selectedRoster(next), expected);
      }
    }
  }
});

test("session directory resolution visits project and worktree IDs only linearly", () => {
  let projectReads = 0;
  let worktreeReads = 0;
  const count = 200;
  const worktrees = 16;
  const state = {
    ...emptyWorkspace(),
    projects: Array.from({ length: count }, (_, p) => ({
      get id() {
        projectReads++;
        return `p${p}`;
      },
      directory: `/project/${p}`,
      worktrees: Array.from({ length: worktrees }, (_, w) => ({
        get id() {
          worktreeReads++;
          return `w${w}`;
        },
        path: `/tree/${p}/${w}`,
      })),
      sessions: Array.from({ length: 32 }, (_, s) =>
        session(`p${p}s${s}`, { worktreeId: `w${s % worktrees}` }),
      ),
    })),
  };
  const entries = sessionEntries(state);
  assert.equal(entries.length, count * 32);
  assert.equal(entries.at(-1).directory, "/tree/199/15");
  assert.ok(projectReads <= count, `project ID reads: ${projectReads}`);
  assert.ok(worktreeReads <= count * worktrees, `worktree ID reads: ${worktreeReads}`);
});

test("selecting one roster does not materialize every project's split metadata", () => {
  let splitReads = 0;
  const state = {
    ...emptyWorkspace(),
    selectedWorkspace: "local",
    selectedSession: "s199",
    projects: Array.from({ length: 200 }, (_, p) => ({
      id: `p${p}`,
      directory: `/project/${p}`,
      sessions: [session(`s${p}`)],
      get splitGroups() {
        splitReads++;
        return undefined;
      },
    })),
  };
  assert.equal(selectedRoster(state).id, "p199");
  assert.equal(splitReads, 1);
  assert.equal(selectedRoster({ ...state, selectedSession: "absent" }), undefined);
  assert.equal(splitReads, 1);
});
