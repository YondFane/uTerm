import test from "node:test";
import assert from "node:assert/strict";
import { validDatabaseConfig, databaseError } from "../src/lib/database.ts";
import { emptyWorkspace, readWorkspace, canRemoveWorkspace } from "../src/lib/workspace.ts";
import { defaults, readSettings } from "../src/lib/settings.ts";

const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "QA",
  kind: "mysql",
  host: "127.0.0.1",
  port: 3306,
  database: "",
  username: "user",
  tls: true,
  ca_file: "",
  credential_id: null,
};
test("database profiles round trip across workspace reads without retaining passwords or SQL", () => {
  for (const kind of ["mysql", "postgresql", "oracle"]) {
    const config = { ...profile, kind, database: "qa" };
    assert.equal(validDatabaseConfig(config), true);
    const state = emptyWorkspace();
    state.groups[0].databaseConnections = [config];
    assert.deepEqual(readWorkspace(JSON.stringify(state)).groups[0].databaseConnections, [config]);
    for (const patch of [
      { password: "sensitive" },
      { sql: "SELECT 1" },
      { host: "host?sslmode=disable" },
      { database: "qa;DROP TABLE x" },
      { kind: "unknown" },
      { port: 0 },
      { credential_id: "untrusted" },
    ]) {
      state.groups[0].databaseConnections = [{ ...config, ...patch }];
      assert.equal(validDatabaseConfig(state.groups[0].databaseConnections[0]), false);
      assert.throws(() => readWorkspace(JSON.stringify(state)));
    }
  }
  const state = emptyWorkspace();
  delete state.groups[0].databaseConnections;
  assert.deepEqual(readWorkspace(JSON.stringify(state)).groups[0].databaseConnections, []);
  state.groups[0].databaseConnections = [profile];
  assert.equal(canRemoveWorkspace(state, state.groups[0].id), false);
});
test("database visibility migrates independently and rejects malformed settings", () => {
  const { showDatabaseConnections, ...old } = defaults;
  assert.equal(readSettings(JSON.stringify(old)).showDatabaseConnections, true);
  const value = readSettings(JSON.stringify({ ...defaults, showDatabaseConnections: false }));
  assert.equal(value.showDatabaseConnections, false);
  assert.equal(value.showRedisConnections, true);
  assert.equal(value.showSshConnections, true);
  for (const input of [null, 0, "false", []])
    assert.throws(() =>
      readSettings(JSON.stringify({ ...defaults, showDatabaseConnections: input })),
    );
});
test("database diagnostics omit raw credential-bearing server messages", () => {
  assert.doesNotMatch(databaseError("server echoed sensitive-password"), /sensitive-password/);
  assert.doesNotMatch(databaseError("DB_SQL:1045:28000"), /password/);
});
