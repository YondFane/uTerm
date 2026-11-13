import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { visibleControlBounds } from "../src/qa/visible-bounds.ts";

function fixture(t) {
  const dom = new JSDOM("<div><button>Save</button></div>");
  t.after(() => dom.window.close());
  return {
    window: dom.window,
    parent: dom.window.document.querySelector("div"),
    control: dom.window.document.querySelector("button"),
  };
}
function bounds(element, left, top, width, height, client = {}) {
  element.getBoundingClientRect = () =>
    new element.ownerDocument.defaultView.DOMRect(left, top, width, height);
  for (const [key, value] of Object.entries({
    offsetWidth: width,
    offsetHeight: height,
    clientWidth: width,
    clientHeight: height,
    clientLeft: 0,
    clientTop: 0,
    ...client,
  })) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
}

test("run Save rejects a partially clipped scroll viewport despite its full 28px bounds", (t) => {
  const { parent, control } = fixture(t);
  parent.style.overflowY = "auto";
  bounds(parent, 0, 0, 200, 100);
  bounds(control, 10, 90, 100, 28);
  assert.deepEqual(visibleControlBounds(control), { width: 100, height: 10 });
  bounds(control, 10, 60, 100, 28);
  assert.deepEqual(visibleControlBounds(control), { width: 100, height: 28 });
});

test("run control clipping respects independent axes and allows visible overflow", (t) => {
  const { parent, control } = fixture(t);
  parent.style.overflowX = "clip";
  parent.style.overflowY = "visible";
  bounds(parent, 0, 0, 100, 20);
  bounds(control, 90, 30, 100, 28);
  assert.deepEqual(visibleControlBounds(control), { width: 10, height: 28 });
  parent.style.overflowX = "visible";
  assert.deepEqual(visibleControlBounds(control), { width: 100, height: 28 });
});

test("run control clipping excludes borders and preserves transformed client geometry", (t) => {
  const { parent, control } = fixture(t);
  parent.style.overflowX = "hidden";
  parent.style.overflowY = "hidden";
  bounds(parent, 0, 0, 220, 220, {
    offsetWidth: 110,
    offsetHeight: 110,
    clientWidth: 100,
    clientHeight: 100,
    clientLeft: 5,
    clientTop: 5,
  });
  bounds(control, 205, 205, 20, 20);
  assert.deepEqual(visibleControlBounds(control), { width: 5, height: 5 });
});

test("run controls are clipped by the actual window even without a scroll ancestor", (t) => {
  const { window, control } = fixture(t);
  bounds(control, window.innerWidth - 14, window.innerHeight - 8, 100, 28);
  assert.deepEqual(visibleControlBounds(control), { width: 14, height: 8 });
});
