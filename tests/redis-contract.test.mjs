import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Redis operation JSON preserves binary identity and exact numeric text", () => {
  const operation = JSON.parse(
    readFileSync(new URL("../shared/contracts/redis-values-v1.json", import.meta.url), "utf8"),
  );
  const result = operation.result;
  assert.deepEqual([...Buffer.from(result.binary.data, "base64")], [0, 255, 127]);
  assert.equal(result.binary.text, null);
  assert.deepEqual([...Buffer.from(result.key, "base64")], [0, 255, 127]);
  assert.deepEqual([...Buffer.from(result.member, "base64")], [255, 0]);
  assert.equal(result.text, "9223372036854775807 中文🚀");
  assert.equal(BigInt(result.text.split(" ")[0]), 9223372036854775807n);
  assert.deepEqual(JSON.parse(JSON.stringify(operation)), operation);
});
