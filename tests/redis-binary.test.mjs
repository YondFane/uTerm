import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { redisBinaryInfo } from "../src/lib/redis-binary.ts";

// Generated once by Java ObjectOutputStream; running these tests needs no JVM. 使用 Java ObjectOutputStream 一次性生成；运行测试不需要 JVM。
const serialized = Buffer.from(
  readFileSync(new URL("./fixtures/redis-auth-info.base64", import.meta.url), "utf8").trim(),
  "base64",
);
const blob = (bytes, truncated = false) => ({
  data: bytes.toString("base64"),
  text: null,
  size: bytes.length,
  truncated,
});

test("Java binary previews inspect real descriptors, shared type references and modified UTF-8", () => {
  const value = blob(serialized);
  const info = redisBinaryInfo(value);
  assert.deepEqual(info.java, {
    version: 5,
    className: "com.core.AuthInfo",
    serialVersionUid: "-42",
    fields: [
      { name: "active", type: "boolean" },
      { name: "userId", type: "int" },
      { name: "account", type: "java.lang.String" },
      { name: "avatar", type: "java.lang.String" },
      { name: "roles", type: "java.lang.String[]" },
      { name: "scores", type: "int[]" },
      { name: "昵称𐐀", type: "java.lang.String" },
    ],
    partial: false,
  });
  assert.match(info.text, /示例用户/);
  assert.match(info.text, /https:\/\/example.test\/avatar/);
  assert.match(info.text, /reader/);
  assert.equal(value.data, serialized.toString("base64"));
  assert.equal(info.limited, false);
  assert.equal(redisBinaryInfo(value, 1024 * 1024).java, null);
});

test("binary previews retain readable text, replace controls and bound decoding", () => {
  const bytes = Buffer.concat([Buffer.from([0, 255, 27]), Buffer.from("中文\ntext\tend")]);
  const info = redisBinaryInfo(blob(bytes));
  assert.equal(info.java, null);
  assert.equal(info.text, "·�·中文\ntext\tend");
  const large = redisBinaryInfo(blob(Buffer.alloc(2 * 1024 * 1024, 97)));
  assert.equal(large.bytes, 65536);
  assert.equal(large.text.length, 65536);
  assert.equal(large.limited, true);
  assert.equal(redisBinaryInfo(blob(bytes, true)).limited, true);
});

test("truncated and malformed Java headers preserve partial metadata without throwing", () => {
  for (let length = 0; length < serialized.length; length++) {
    assert.doesNotThrow(() => redisBinaryInfo(blob(serialized.subarray(0, length))));
  }
  const truncated = redisBinaryInfo(blob(serialized.subarray(0, 64)));
  assert.equal(truncated.java.className, "com.core.AuthInfo");
  assert.equal(truncated.java.partial, true);
  const version = Buffer.from(serialized);
  version[3] = 6;
  assert.equal(redisBinaryInfo(blob(version)).java.className, null);
  assert.equal(redisBinaryInfo(blob(version)).java.version, 6);
  const invalidName = Buffer.from(serialized);
  invalidName.writeUInt16BE(65535, 6);
  assert.equal(redisBinaryInfo(blob(invalidName)).java.className, null);
  const invalidReference = Buffer.from(serialized);
  const reference = invalidReference.indexOf(Buffer.from([0x71, 0, 0x7e, 0, 1]));
  assert.ok(reference > 0);
  invalidReference[reference + 4] = 20;
  const rejected = redisBinaryInfo(blob(invalidReference));
  assert.equal(rejected.java.partial, true);
  assert.deepEqual(rejected.java.fields.at(-1), { name: "account", type: "java.lang.String" });
});

test("Java descriptor fields remain bounded for excessive declared counts", () => {
  const countOffset = 8 + serialized.readUInt16BE(6) + 9;
  const count = Buffer.alloc(2);
  count.writeUInt16BE(257);
  const fields = Buffer.from("I\u0000\u0001x".repeat(257));
  const bytes = Buffer.concat([serialized.subarray(0, countOffset), count, fields]);
  const info = redisBinaryInfo(blob(bytes));
  assert.equal(info.java.fields.length, 256);
  assert.equal(info.java.partial, true);
});
