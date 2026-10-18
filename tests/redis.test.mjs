import test from "node:test";
import assert from "node:assert/strict";
import {
  validRedisConfig,
  redisArguments,
  redisEncode,
  redisDisplay,
  redisValidScore,
} from "../src/lib/redis.ts";
import {
  emptyWorkspace,
  readWorkspace,
  createWorkspaceGroup,
  canRemoveWorkspace,
} from "../src/lib/workspace.ts";

const config = () => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Redis QA",
  host: "127.0.0.1",
  port: 6379,
  db: 0,
  username: "",
  tls: false,
  ca_file: "",
  server_name: "",
  ssh_host: "",
  credential_id: null,
});
test("ZSet scores accept finite decimal values without converting the submitted text", () => {
  for (const value of ["0", "-0", "0e-999", "+.5", "1.25", "1e-20", "-1.2345678901234567e100"])
    assert.equal(redisValidScore(value), true, value);
  for (const value of [
    "",
    " ",
    " 1",
    "1 ",
    "0x12",
    "NaN",
    "inf",
    "-Infinity",
    "1e999",
    "1e-999",
    "-1e-999",
    "1,2",
  ])
    assert.equal(redisValidScore(value), false, value);
});
test("binary hex previews decode only the displayed prefix", () => {
  const original = globalThis.atob;
  let largest = 0;
  globalThis.atob = (value) => {
    largest = Math.max(largest, value.length);
    return original(value);
  };
  try {
    const value = {
      data: Buffer.alloc(2 * 1024 * 1024, 255).toString("base64"),
      text: null,
      size: 2 * 1024 * 1024,
      truncated: false,
    };
    assert.equal(redisDisplay(value), Array(256).fill("ff").join(" ") + " …");
    assert.ok(largest <= 344);
    assert.equal(
      redisDisplay({ ...value, data: Buffer.alloc(256, 0).toString("base64") }),
      Array(256).fill("00").join(" "),
    );
  } finally {
    globalThis.atob = original;
  }
});
test("Redis workspace migration preserves SSH and rejects credentials or malformed endpoints", () => {
  for (const version of [3, 4, 5, 6, 7]) {
    const state = { ...emptyWorkspace(), version };
    state.groups[0].redisConnections = [config()];
    const restored = readWorkspace(JSON.stringify(state));
    assert.equal(restored.version, 7);
    assert.deepEqual(restored.groups[0].redisConnections, [config()]);
  }
  for (const invalid of [
    { ...config(), password: "must-not-persist" },
    { ...config(), host: "-oProxyCommand=bad" },
    { ...config(), port: 0 },
    { ...config(), port: 65536 },
    { ...config(), db: -1 },
    { ...config(), credential_id: "password" },
    { ...config(), ssh_host: "host;echo" },
  ]) {
    assert.equal(validRedisConfig(invalid), false);
    const state = emptyWorkspace();
    state.groups[0].redisConnections = [invalid];
    assert.throws(() => readWorkspace(JSON.stringify(state)));
  }
  const state = emptyWorkspace();
  state.groups[0].redisConnections = [config(), config()];
  assert.throws(() => readWorkspace(JSON.stringify(state)), /Redis/);
});
test("Redis byte identities and console quoting do not invoke a shell", () => {
  assert.equal(redisEncode("中文\u0000key"), Buffer.from("中文\u0000key").toString("base64"));
  assert.deepEqual(redisArguments('TYPE "key with spaces"'), ["TYPE", "key with spaces"]);
  assert.deepEqual(redisArguments("TYPE '$(id);echo'"), ["TYPE", "$(id);echo"]);
  assert.deepEqual(redisArguments('TYPE ""'), ["TYPE", ""]);
  assert.throws(() => redisArguments('TYPE "broken'));
  assert.equal(redisDisplay({ data: "AP8=", text: null, size: 2, truncated: false }), "00 ff");
  assert.equal(redisDisplay({ data: "YQ==", text: "a", size: 3, truncated: true }), "a …");
});

test("Redis profiles prevent removing their workspace", () => {
  const state = emptyWorkspace();
  state.groups.push(createWorkspaceGroup("other", "Other"));
  state.groups[1].redisConnections = [config()];
  assert.equal(canRemoveWorkspace(state, "other"), false);
});
