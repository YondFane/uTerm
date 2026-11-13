import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseJavaArguments,
  formatJavaArguments,
  parseJavaEnvironment,
} from "../src/lib/java-build.ts";
import { parsePythonArguments, parsePythonEnvironment } from "../src/lib/python-run.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../shared/fixtures/run-panel-input.json", import.meta.url), "utf8"),
);

test("shared run arguments preserve quotes, empty values, Unicode and literal shell syntax", () => {
  for (const parse of [parseJavaArguments, parsePythonArguments]) {
    for (const row of fixture.validArguments)
      assert.deepEqual(parse(row.text), row.expected, row.name);
    for (const text of fixture.invalidArguments) assert.throws(() => parse(text));
  }
});

test("run argument formatting preserves original values without introducing control escapes", () => {
  for (const values of fixture.roundTrips) {
    const text = formatJavaArguments(values);
    assert.deepEqual(parseJavaArguments(text), values);
    assert.deepEqual(parsePythonArguments(text), values);
  }
});

test("shared temporary environment input rejects duplicate and host control names", () => {
  for (const parse of [parseJavaEnvironment, parsePythonEnvironment]) {
    for (const row of fixture.validEnvironment)
      assert.deepEqual({ ...parse(row.text) }, row.expected, row.name);
    for (const text of fixture.invalidEnvironment) assert.throws(() => parse(text));
  }
});
