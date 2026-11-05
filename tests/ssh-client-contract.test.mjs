import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("shared SSH progress preserves u64 values above JavaScript numeric precision", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../shared/contracts/ssh-progress-v1.json", import.meta.url), "utf8"),
  );
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(
    fixture.progress.map((value) => value.completed),
    ["9007199254740993", "18446744073709551615"],
  );
  for (const value of fixture.progress) {
    assert.equal(typeof value.completed, "string");
    assert.equal(BigInt(value.completed).toString(), value.completed);
    assert.equal(BigInt(value.total), 18446744073709551615n);
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  }
});
