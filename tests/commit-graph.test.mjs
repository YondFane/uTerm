import test from "node:test";
import assert from "node:assert/strict";
import { commitGraph } from "../src/lib/git-history.ts";

test("linear history connects nodes and ends at the root", () => {
  const rows = commitGraph([
    { id: "a", parents: ["b"] },
    { id: "b", parents: [] },
  ]);
  assert.equal(rows[0].incoming, false);
  assert.equal(rows[1].incoming, true);
  assert.deepEqual(rows[1].parents, []);
  assert.equal(rows[0].color, rows[1].color);
});

test("merge branches converge on one shared ancestor", () => {
  const rows = commitGraph([
    { id: "merge", parents: ["left", "right"] },
    { id: "right", parents: ["root"] },
    { id: "left", parents: ["root"] },
    { id: "root", parents: [] },
  ]);
  assert.deepEqual(
    rows[0].parents.map((edge) => edge.lane),
    [0, 1],
  );
  assert.equal(rows[1].lane, 1);
  assert.equal(rows[2].parents[0].lane, 0);
  assert.equal(rows[3].width, 1);
  assert.ok(rows.every((row) => row.continuations.every((edge) => edge.to >= 0)));
});

test("appending a page preserves existing edges including octopus merges", () => {
  const page = [{ id: "merge", parents: ["a", "b", "c"] }];
  assert.deepEqual(commitGraph(page)[0], commitGraph([...page, { id: "a", parents: [] }])[0]);
  assert.equal(commitGraph(page)[0].parents.length, 3);
});
