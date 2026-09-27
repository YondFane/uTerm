import test from "node:test";
import assert from "node:assert/strict";
import { sidebarLayout } from "../src/lib/sidebar-layout.ts";
import { inspectorDragLayout } from "../src/lib/inspector-layout.ts";

test("snap eligibility clears when a held drag returns above the threshold", () => {
  for (const layout of [sidebarLayout, inspectorDragLayout]) {
    assert.deepEqual(
      [100, 30, 12, 31, 80].map((width) => layout(1000, width).hidden),
      [false, true, true, false, false],
    );
    assert.equal(layout(1000, 12).width, 30);
    assert.equal(layout(1000, 80).width, 80);
  }
});

test("sidebar bounds preserve the main area and collapse only at the drag threshold", () => {
  assert.equal(sidebarLayout(1100, 30).hidden, true);
  assert.equal(sidebarLayout(1100, 31).hidden, false);
  assert.equal(sidebarLayout(1100, 160).hidden, false);
  assert.equal(sidebarLayout(1100, 31).width, 31);
  assert.equal(sidebarLayout(1100, 30).width, 30);
  assert.equal(sidebarLayout(1100, 100).width, 100);
  assert.equal(sidebarLayout(1100, 9999).width, 320);
  assert.equal(sidebarLayout(640, 9999).width, 192);
  assert.equal(sidebarLayout(1100, 248).width, 248);
});
