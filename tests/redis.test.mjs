import test from "node:test";
import assert from "node:assert/strict";
import { validRedisConfig, redisArguments, redisEncode, redisDisplay } from "../src/lib/redis.ts";
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
test("Redis workspace migration preserves SSH and rejects credentials or malformed endpoints", () => {
  for (const version of [3, 4, 5]) {
    const state = { ...emptyWorkspace(), version };
    state.groups[0].redisConnections = [config()];
    const restored = readWorkspace(JSON.stringify(state));
    assert.equal(restored.version, 5);
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
