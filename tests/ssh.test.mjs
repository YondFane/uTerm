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
import { sshEndpoint, parseQuickSsh, matchesSsh } from "../src/lib/ssh.ts";
import { validSshJump, validSshForward, sshTargetFor } from "../src/lib/workspace.ts";
import { resolveRedisSsh } from "../src/lib/redis.ts";

test("quick connections parse addresses without accepting commands, passwords or malformed ports", () => {
  assert.equal(parseQuickSsh("prod").mode, "alias");
  assert.equal(parseQuickSsh("prod").port, undefined);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(parseQuickSsh("ssh://dev@[::1]:2222")).filter(([key]) =>
        ["host", "username", "port", "temporary"].includes(key),
      ),
    ),
    { host: "::1", username: "dev", port: 2222, temporary: true },
  );
  assert.equal(parseQuickSsh("127.0.0.1").port, 22);
  for (const address of [
    "",
    "ssh user@host",
    "-oProxyCommand=bad",
    "ssh://user:password@host",
    "host:0",
    "host:65536",
    "host:",
    "a@b@c",
    "host/path",
    "host?x",
    "$(whoami)",
    "host;ls",
    "[::1]bad",
    "ssh://%61@host",
  ])
    assert.equal(parseQuickSsh(address), null, address);
  assert.equal(
    matchesSsh({ name: "Production", host: "db.internal", username: "ops" }, " INternal "),
    true,
  );
  assert.equal(
    matchesSsh({ name: "Production", host: "db.internal", username: "ops" }, "OPS"),
    true,
  );
});
test("SSH jump and forwarding settings survive storage without entering terminal forwarding options", () => {
  const state = emptyWorkspace();
  const profile = {
    id: "jump",
    name: "Jump",
    host: "prod",
    os: "posix",
    root: "",
    sessions: [],
    temporary: false,
    jump_host: "ops@bastion:2222",
    forwards: [
      {
        id: "12345678-1234-1234-1234-123456789abc",
        local_port: 18080,
        remote_host: "127.0.0.1",
        remote_port: 80,
      },
    ],
  };
  state.groups[0].sshConnections = [profile];
  const restored = readWorkspace(JSON.stringify(state)).groups[0].sshConnections[0];
  assert.deepEqual(restored.forwards, profile.forwards);
  assert.equal(restored.jump_host, profile.jump_host);
  assert.equal(sshTargetFor(restored, "local").forwards, undefined);
  for (const jump of ["a,b", "-x", "a:0", "a:65536", "a;exec"])
    assert.equal(validSshJump(jump), false);
  const rule = profile.forwards[0];
  assert.equal(validSshForward({ ...rule, local_port: 0 }), false);
  assert.equal(validSshForward({ ...rule, remote_host: "user@host" }), false);
  const redis = { ssh_host: "old", ssh_target: { ...sshTargetFor(profile, "local"), port: 22 } };
  const current = resolveRedisSsh(redis, [{ ...profile, port: 2222 }], "local");
  assert.equal(current.ssh_host, "prod");
  assert.equal(current.ssh_target.port, 2222);
  assert.equal(current.ssh_target.jump_host, profile.jump_host);
  assert.equal(resolveRedisSsh(redis, [{ ...profile, temporary: true }], "local"), redis);
});

test("SSH endpoints bracket IPv6 and never invent inherited usernames or ports", () => {
  const target = { host: "prod", mode: "alias" };
  assert.equal(sshEndpoint(target), "prod");
  assert.equal(
    sshEndpoint({ ...target, host: "2001:db8::1", username: "dev", port: 2222 }),
    "dev@[2001:db8::1]:2222",
  );
  assert.equal(
    sshEndpoint(target, { hostname: "[::1]", username: "resolved", port: "2200", proxy: false }),
    "resolved@[::1]:2200",
  );
});
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
