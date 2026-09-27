import test from "node:test";
import assert from "node:assert/strict";
import { sameGitSnapshot } from "../src/lib/git-snapshot.ts";

const snapshot = {
  root: "/project",
  branch: "main",
  references: ["main", "origin/main"],
  changes: [{ path: "file.txt", original: null, index: " ", working: "M" }],
  truncated: false,
};

test("Git snapshots compare without serializing unchanged file lists", () => {
  assert.equal(sameGitSnapshot(snapshot, structuredClone(snapshot)), true);
  assert.equal(
    sameGitSnapshot(snapshot, { ...snapshot, changes: [{ ...snapshot.changes[0], working: " " }] }),
    false,
  );
  assert.equal(sameGitSnapshot(snapshot, { ...snapshot, references: ["main"] }), false);
});
