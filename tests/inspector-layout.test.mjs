import test from "node:test";
import assert from "node:assert/strict";
import { hasInspectorContent, inspectorLayout } from "../src/lib/inspector-layout.ts";
test("inspector resizing reserves usable widths for both columns", () => {
  for (const available of [392, 560, 852, 1200, 2200]) {
    for (const ratio of [-2, 0.2, 0.35, 0.6, 4]) {
      const layout = inspectorLayout(available, ratio);
      assert.ok(layout.width >= 240);
      assert.ok(layout.available - layout.width >= 320);
      assert.ok(layout.ratio >= 0.2 && layout.ratio <= 0.6);
    }
  }
});
test("width follows the available space without losing the requested ratio", () => {
  assert.equal(inspectorLayout(1000, 0.4).width, 400);
  assert.equal(inspectorLayout(1500, 0.4).width, 600);
  assert.equal(inspectorLayout(852, 1).width, 511.2);
});

test("inspector columns require renderable content instead of only an open preference", () => {
  const panels = { files: false, directory: false, git: false, github: false };
  for (const key of Object.keys(panels)) {
    const open = { ...panels, [key]: true };
    assert.equal(hasInspectorContent("", false, open), false);
    assert.equal(hasInspectorContent("/project", true, open), true);
    assert.equal(hasInspectorContent("/home", false, open), key === "files" || key === "directory");
  }
  assert.equal(hasInspectorContent("/project", true, panels), false);
});
