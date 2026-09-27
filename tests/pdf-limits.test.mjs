import test from "node:test";
import assert from "node:assert/strict";
import { boundedPdfScale } from "../src/lib/pdf-limits.ts";

test("PDF canvas dimensions remain bounded for large pages and thumbnails", () => {
  for (const thumbnail of [false, true]) {
    for (const [width, height] of [
      [612, 792],
      [1e8, 1e8],
      [1, 1e9],
    ]) {
      const scale = boundedPdfScale(width, height, 3, thumbnail);
      assert.ok(width * height * scale * scale <= (thumbnail ? 128 * 1024 : 4 * 1024 * 1024) + 1);
      assert.ok(Math.max(width, height) * scale <= (thumbnail ? 512 : 4096) + 1);
    }
  }
  assert.equal(boundedPdfScale(612, 792, 1, false), 1);
});
test("invalid PDF dimensions are rejected before allocating a canvas", () => {
  for (const dimension of [0, -1, Infinity, NaN])
    assert.throws(() => boundedPdfScale(dimension, 100, 1, false));
});
