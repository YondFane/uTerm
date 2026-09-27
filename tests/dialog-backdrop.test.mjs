import test from "node:test";
import assert from "node:assert/strict";
import { outsideDialog } from "../src/lib/useDialogBackdrop.ts";

test("dialog backdrop excludes content, padding and borders on all edges", () => {
  const rect = { left: 100, right: 500, top: 80, bottom: 400 };
  for (const [x, y] of [
    [100, 80],
    [500, 400],
    [300, 200],
    [101, 81],
  ])
    assert.equal(outsideDialog(rect, x, y), false);
  for (const [x, y] of [
    [99, 200],
    [501, 200],
    [300, 79],
    [300, 401],
  ])
    assert.equal(outsideDialog(rect, x, y), true);
});
