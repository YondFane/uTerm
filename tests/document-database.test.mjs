import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, delimiter } from "node:path";
import { validDatabaseConfig, databaseDependencies } from "../src/lib/database.ts";
import { readWorkspace, emptyWorkspace } from "../src/lib/workspace.ts";
import { validDocumentJson } from "../src/lib/document-database.ts";

test("document profiles preserve authentication settings and reject protocol injection", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "QA",
    host: "127.0.0.1",
    port: 9200,
    database: "qa",
    username: "",
    tls: true,
    ca_file: "",
    credential_id: null,
  };
  for (const config of [
    { ...base, kind: "elasticsearch", auth_mode: "api_key" },
    { ...base, kind: "mongodb", auth_source: "admin" },
  ]) {
    assert.equal(validDatabaseConfig(config), true);
    const state = emptyWorkspace();
    state.groups[0].databaseConnections = [config];
    assert.deepEqual(readWorkspace(JSON.stringify(state)).groups[0].databaseConnections, [config]);
    assert.equal(validDatabaseConfig({ ...config, host: "localhost/?tls=false" }), false);
  }
  assert.equal(validDatabaseConfig({ ...base, kind: "mysql", auth_source: "admin" }), false);
  assert.equal(
    validDatabaseConfig({ ...base, kind: "mongodb", auth_source: "admin?tls=false" }),
    false,
  );
  assert.deepEqual(databaseDependencies("elasticsearch"), []);
  assert.deepEqual(databaseDependencies("mongodb"), [
    "runtime",
    "mongodb",
    "mongodb-core",
    "mongodb-bson",
  ]);
  for (const value of ["[]", "null", "1", "{", '{"a":"' + "x".repeat(262144) + '"}'])
    assert.equal(validDocumentJson(value), false);
  assert.equal(validDocumentJson('{"n":123456789012345678901234567890}'), true);
});

test(
  "real MongoDB Java driver preserves BSON and enforces guards with a disposable wire fixture",
  { skip: !process.env.UTERM_MONGODB_DRIVER_TEST, timeout: 60000 },
  () => {
    const classpath = [
      "components/database/engine.jar",
      ...["mongodb-driver-sync", "mongodb-driver-core", "bson"].map(
        (name) => `components/database/target/mongodb/${name}.jar`,
      ),
    ]
      .map((name) => resolve(name))
      .join(delimiter);
    const output = execFileSync(
      process.env.UTERM_DATABASE_JAVA || "java",
      ["-Xmx128m", "-cp", classpath, resolve("tests/fixtures/MongoBridgeProbe.java")],
      { timeout: 45000, stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.match(
      output.toString(),
      /MongoDB driver, canonical BSON, read guards and conflict checks passed/,
    );
  },
);
