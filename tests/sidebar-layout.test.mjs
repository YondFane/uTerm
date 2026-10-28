import test from "node:test";
import assert from "node:assert/strict";
import { sidebarLayout } from "../src/lib/sidebar-layout.ts";
import { inspectorDragLayout } from "../src/lib/inspector-layout.ts";

test("snap eligibility clears when a held drag returns above the threshold", () => {
  for (const [layout, threshold, minimum] of [
    [sidebarLayout, 78, 48],
    [inspectorDragLayout, 30, 30],
  ]) {
    assert.deepEqual(
      [100, threshold, 12, threshold + 1, 100].map((width) => layout(1000, width).hidden),
      [false, true, true, false, false],
    );
    assert.equal(layout(1000, 12).width, minimum);
    assert.equal(layout(1000, 100).width, 100);
  }
});

test("sidebar resizing reserves the rail, preserves the main area and collapses only the list", () => {
  assert.equal(sidebarLayout(1100, 0).width, 48);
  assert.equal(sidebarLayout(1100, 48).minimum, 48);
  assert.equal(sidebarLayout(1100, 78).hidden, true);
  assert.equal(sidebarLayout(1100, 79).hidden, false);
  assert.equal(sidebarLayout(1100, 248).width, 248);
  assert.equal(sidebarLayout(1100, 9999).width, 320);
  assert.equal(sidebarLayout(640, 9999).width, 192);
});
