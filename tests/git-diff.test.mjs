import test from "node:test";
import assert from "node:assert/strict";
import {
  hasCurrentWorkingDiff,
  isStaleWorkingDiffError,
  sideBySideDiff,
} from "../src/lib/git-diff.ts";

test("working diff selection expires without asking the user to refresh", () => {
  const changes = [
    { path: "staged.txt", index: "M", working: " " },
    { path: "working.txt", index: " ", working: "M" },
    { path: "new.txt", index: "?", working: "?" },
  ];

  assert.equal(hasCurrentWorkingDiff(changes, "staged.txt", "staged"), true);
  assert.equal(hasCurrentWorkingDiff(changes, "working.txt", "working"), true);
  assert.equal(hasCurrentWorkingDiff(changes, "new.txt", "staged"), false);
  assert.equal(hasCurrentWorkingDiff(changes, "gone.txt", "working"), false);
  assert.equal(isStaleWorkingDiffError("文件已变化，请刷新列表。"), true);
});

test("aligns unequal replacements and preserves context line numbers", () => {
  const rows = sideBySideDiff("@@ -5,3 +8,4 @@\n same\n-old\n+new\n+extra\n end\n");
  assert.equal(rows[1].left.line, 5);
  assert.equal(rows[2].left.text, "old");
  assert.equal(rows[2].right.text, "new");
  assert.equal(rows[3].left, undefined);
  assert.equal(rows[3].right.line, 10);
  assert.equal(rows[4].left.line, 7);
  assert.equal(rows[4].right.line, 11);
});

test("distinguishes file headers from added text starting with plus signs", () => {
  const rows = sideBySideDiff(
    "--- /dev/null\n+++ b/file\n@@ -0,0 +1 @@\n+++content\n\\ No newline at end of file\n",
  );
  assert.equal(rows[1].header, "+++ b/file");
  assert.equal(rows[3].right.text, "++content");
  assert.equal(rows[3].left, undefined);
  assert.equal(rows[4].header, "\\ No newline at end of file");
});

test("preserves binary messages and resets numbers between hunks", () => {
  assert.deepEqual(sideBySideDiff("Binary files differ"), [{ header: "Binary files differ" }]);
  const rows = sideBySideDiff("@@ -1 +1,0 @@\n-gone\n@@ -10 +9 @@\n-old\n+new\n");
  assert.equal(rows[1].right, undefined);
  assert.equal(rows[3].left.line, 10);
  assert.equal(rows[3].right.line, 9);
});
