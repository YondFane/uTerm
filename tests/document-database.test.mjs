import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, delimiter } from "node:path";
import {
  validDatabaseConfig,
  databaseDependencies,
  parseElasticsearchAddress,
} from "../src/lib/database.ts";
import { readWorkspace, emptyWorkspace } from "../src/lib/workspace.ts";
import { validDocumentJson } from "../src/lib/document-database.ts";

test("Elasticsearch addresses normalize root URLs without accepting URL options or credentials", () => {
  for (const [input, expected] of [
    ["https://es.example.com", { host: "es.example.com", port: 443, tls: true }],
    ["http://es.example.com/", { host: "es.example.com", port: 80, tls: false }],
    [" HTTPS://ES.EXAMPLE.COM:9243/ ", { host: "es.example.com", port: 9243, tls: true }],
    ["https://es.example.com:443", { host: "es.example.com", port: 443, tls: true }],
    ["http://127.0.0.1:9200", { host: "127.0.0.1", port: 9200, tls: false }],
    ["https://[::1]:9243", { host: "::1", port: 9243, tls: true }],
    ["es.example.com", { host: "es.example.com" }],
    [" 127.0.0.1 ", { host: "127.0.0.1" }],
    ["::1", { host: "::1" }],
  ]) {
    assert.deepEqual(parseElasticsearchAddress(input), expected, input);
    assert.equal(
      validDatabaseConfig({
        id: "11111111-1111-4111-8111-111111111111",
        name: "QA",
        kind: "elasticsearch",
        host: "",
        port: 9200,
        tls: false,
        database: "",
        username: "",
        ca_file: "",
        credential_id: null,
        ...expected,
      }),
      true,
    );
  }
  for (const input of [
    "",
    "https://",
    "https:example.com",
    "ftp://es.example.com",
    "//es.example.com",
    "https://user:secret@es.example.com",
    "https://@es.example.com",
    "https://es.example.com/index",
    "https://es.example.com/../",
    "https://es.example.com?tls=false",
    "https://es.example.com?",
    "https://es.example.com/#",
    "https://es.example.com/#fragment",
    "https://es.example.com:0",
    "https://es.example.com:65536",
    "https://es.example.com:",
    "https://es.example.com:abc",
    "https://es.example.com\\other",
    "https://es.example.com\n",
    "https://es.example.com\t",
    "https://es.example.com%2fother",
    "https://[bad-ipv6]",
    "-invalid",
    "a".repeat(256),
  ])
    assert.equal(parseElasticsearchAddress(input), null, input);
});

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
