import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyWorkspace,
  createWorkspaceGroup,
  readWorkspace,
  validSshHost,
  groupSessions,
  sessionRosters,
  selectedRoster,
  selectSession,
  updateRoster,
  removeSession,
  reconcileSshSessions,
  canRemoveWorkspace,
  reconcileLocalSessions,
} from "../src/lib/workspace.ts";
import { fileTarget, remoteDirectory, displayDirectory } from "../src/lib/file-target.ts";
import { readDraft } from "../src/lib/file-document.ts";
const connection = (id, workspace = "local") => ({
  id,
  name: id,
  host: "lab",
  os: "windows",
  root: "C:/Users/测试",
  splitGroups: [],
  sessions: [
    {
      id: `${id}-s`,
      name: id,
      shell: "default",
      pinned: false,
      directory: "/local",
      ssh: {
        connection_id: id,
        workspace_id: workspace,
        name: id,
        host: "lab",
        os: "windows",
        root: "C:/Users/测试",
      },
    },
  ],
});
const fixture = () => {
  const state = emptyWorkspace();
  state.groups[0].sshConnections = [connection("a"), connection("b")];
  return selectSession(state, "a-s");
};

test("SSH storage upgrades v3, validates targets and preserves grouping boundaries", () => {
  assert.equal(readWorkspace(JSON.stringify({ ...emptyWorkspace(), version: 3 })).version, 7);
  const state = fixture();
  const restored = readWorkspace(JSON.stringify(state));
  assert.deepEqual(restored, state);
  assert.equal(selectedRoster(restored).kind, "ssh");
  assert.equal(groupSessions(state, "a-s", "b-s", "horizontal"), state);
  const next = updateRoster(state, "ssh:a", (roster) => ({
    ...roster,
    sessions: [...roster.sessions, { ...roster.sessions[0], id: "a-second" }],
  }));
  const grouped = groupSessions(next, "a-s", "a-second", "horizontal");
  assert.equal(selectedRoster(grouped).splitGroups.length, 1);
  assert.equal(
    removeSession(grouped, "a-s").groups[0].sshConnections[0].sessions[0].id,
    "a-second",
  );
  const other = createWorkspaceGroup("other", "Other");
  assert.equal(canRemoveWorkspace({ ...state, groups: [...state.groups, other] }, "local"), false);
  for (const mutate of [
    (state) => {
      state.groups[0].sshConnections[0].host = "-oProxyCommand=bad";
    },
    (state) => {
      state.groups[0].sshConnections[0].sessions[0].ssh.connection_id = "b";
    },
    (state) => {
      state.groups[0].sshConnections[0].sessions[0].agent = "codex";
    },
    (state) => {
      state.groups[0].sshConnections[1].id = "a";
    },
    (state) => {
      state.groups[0].sshConnections[0].root = "bad\0";
    },
  ]) {
    const bad = fixture();
    mutate(bad);
    assert.throws(() => readWorkspace(JSON.stringify(bad)));
  }
  for (const host of ["", "-p22", "host;command", "$(whoami)", "a b", "a\n"])
    assert.equal(validSshHost(host), false);
});
test("SSH discovery restores its owning connection without creating local terminals", () => {
  const state = emptyWorkspace();
  const ssh = connection("a").sessions[0].ssh;
  const snapshot = {
    sessions: [{ id: "remote", directory: "/local", shell: "default", agent: null, ssh }],
    closed: [],
  };
  const restored = reconcileSshSessions(state, snapshot);
  assert.equal(restored.groups[0].terminals.length, 0);
  assert.equal(restored.groups[0].sshConnections[0].sessions[0].id, "remote");
  assert.equal(reconcileSshSessions(restored, snapshot), restored);
  assert.equal(reconcileLocalSessions(state, snapshot.sessions), state);
  assert.equal(
    reconcileSshSessions(restored, { sessions: snapshot.sessions, closed: ["remote"] }).groups[0]
      .sshConnections[0].sessions.length,
    0,
  );
});
test("remote file identities keep same paths on different servers and local files separate", () => {
  const root = {
    connection: connection("a").sessions[0].ssh,
    path: "C:/Users/测试",
    identity: "a".repeat(64),
  };
  const key = remoteDirectory(root);
  assert.deepEqual(fileTarget(key), { kind: "ssh", root });
  assert.equal(displayDirectory(key), "ssh://lab/C:/Users/测试");
  assert.notEqual(key, remoteDirectory({ ...root, identity: "b".repeat(64) }));
  assert.notEqual(
    key,
    remoteDirectory({ ...root, connection: { ...root.connection, host: "other" } }),
  );
  assert.deepEqual(fileTarget("C:/Users/测试"), { kind: "local", directory: "C:/Users/测试" });
  assert.throws(() => fileTarget("uterm-ssh:invalid"));
  const draft = {
    directory: key,
    path: "a.txt",
    kind: "text",
    text: "draft",
    saved: "old",
    version: "0".repeat(64),
    line_ending: "\r\n",
    bom: true,
  };
  assert.equal(readDraft(JSON.stringify(draft)).directory, key);
  assert.throws(() => readDraft(JSON.stringify({ ...draft, directory: "uterm-ssh:broken" })));
});
