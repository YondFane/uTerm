import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("database contract keeps bigint, decimal, binary, null and Unicode cells across JSON", () => {
  const operation = JSON.parse(
    readFileSync(new URL("../shared/contracts/database-values-v1.json", import.meta.url), "utf8"),
  );
  const cells = operation.result.rows[0];
  assert.deepEqual(cells, [
    "9223372036854775807",
    "12345678901234567890.1234567890",
    { binary: "AP9/", truncated: false },
    null,
    "中文🚀",
  ]);
  assert.equal(BigInt(cells[0]), 9223372036854775807n);
  assert.notEqual(BigInt(Number(cells[0])), BigInt(cells[0]));
  assert.deepEqual([...Buffer.from(cells[2].binary, "base64")], [0, 255, 127]);
  assert.deepEqual(JSON.parse(JSON.stringify(operation)).result.rows[0], cells);
});
