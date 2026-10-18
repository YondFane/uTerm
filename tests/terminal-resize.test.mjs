import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { attachTerminalFit, createTerminalResizeQueue } from "../src/lib/terminal-resize.ts";

function fitFixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let observe;
  let disconnected = false;
  const previousObserver = globalThis.ResizeObserver;
  t.after(() => {
    if (previousObserver) globalThis.ResizeObserver = previousObserver;
    else delete globalThis.ResizeObserver;
  });
  globalThis.ResizeObserver = class {
    constructor(callback) {
      observe = callback;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  };
  const writes = [];
  const terminal = { write: (_, callback) => writes.push(callback) };
  const container = { clientWidth: 800, clientHeight: 500 };
  const errors = [];
  let replaying = false;
  let fits = 0;
  let failure;
  const layout = attachTerminalFit(
    terminal,
    container,
    () => {
      if (failure) throw failure;
      fits++;
    },
    () => !replaying,
    (reason) => errors.push(reason),
  );
  t.after(() => layout.dispose());
  return {
    layout,
    container,
    writes,
    errors,
    observe: () => observe(),
    replay: (value) => (replaying = value),
    fail: (value) => (failure = value),
    fits: () => fits,
    disconnected: () => disconnected,
    consume: () => writes.splice(0).forEach((callback) => callback()),
  };
}

test("continuous layout drags keep one grid until sizes settle and old output is consumed", (t) => {
  const value = fitFixture(t);
  for (let i = 0; i < 40; i++) {
    value.observe();
    t.mock.timers.tick(16);
  }
  assert.equal(value.writes.length, 0);
  t.mock.timers.tick(104);
  assert.equal(value.writes.length, 1);
  assert.equal(value.fits(), 0);
  value.consume();
  assert.equal(value.fits(), 1);
});

test("a later layout invalidates a fit waiting behind terminal output", (t) => {
  const value = fitFixture(t);
  value.observe();
  t.mock.timers.tick(120);
  value.observe();
  value.consume();
  assert.equal(value.fits(), 0);
  t.mock.timers.tick(120);
  value.consume();
  assert.equal(value.fits(), 1);
});

test("replay retains saved dimensions until consumption finishes and layout settles", (t) => {
  const value = fitFixture(t);
  value.observe();
  t.mock.timers.tick(120);
  value.layout.cancel();
  value.consume();
  value.replay(true);
  value.observe();
  t.mock.timers.tick(120);
  value.consume();
  assert.equal(value.fits(), 0);
  value.replay(false);
  value.layout.schedule();
  t.mock.timers.tick(120);
  value.consume();
  assert.equal(value.fits(), 1);
});

test("hidden or disposed terminals cannot fit, and fitting failures are reported", (t) => {
  const value = fitFixture(t);
  value.container.clientWidth = 0;
  value.observe();
  t.mock.timers.tick(120);
  value.consume();
  assert.equal(value.fits(), 0);
  value.container.clientWidth = 800;
  const failure = Error("fit failed");
  value.fail(failure);
  value.layout.schedule();
  t.mock.timers.tick(120);
  value.consume();
  assert.deepEqual(value.errors, [failure]);
  value.fail(undefined);
  value.observe();
  t.mock.timers.tick(120);
  value.layout.dispose();
  value.consume();
  value.layout.schedule();
  t.mock.timers.tick(120);
  assert.equal(value.fits(), 0);
  assert.equal(value.writes.length, 0);
  assert.equal(value.disconnected(), true);
});

test("slow host resizes keep only the newest pending size with no concurrent requests", async () => {
  const sent = [];
  let release;
  const queue = createTerminalResizeQueue((size) => {
    sent.push(size);
    return new Promise((resolve) => (release = resolve));
  }, assert.fail);
  queue.request({ rows: 24, cols: 80 });
  for (let cols = 81; cols <= 200; cols++) queue.request({ rows: 30, cols });
  assert.deepEqual(sent, [{ rows: 24, cols: 80 }]);
  release();
  await setImmediate();
  assert.deepEqual(sent, [
    { rows: 24, cols: 80 },
    { rows: 30, cols: 200 },
  ]);
  release();
  await setImmediate();
  queue.dispose();
});

test("resize failures stay visible and do not block the final size", async () => {
  const sent = [];
  const errors = [];
  let reject;
  const queue = createTerminalResizeQueue(
    (size) => {
      sent.push(size);
      return sent.length === 1 ? new Promise((_, fail) => (reject = fail)) : Promise.resolve();
    },
    (reason) => errors.push(reason),
  );
  queue.request({ rows: 24, cols: 80 });
  queue.request({ rows: 30, cols: 120 });
  const failure = Error("host unavailable");
  reject(failure);
  await setImmediate();
  assert.deepEqual(errors, [failure]);
  assert.equal(sent.length, 2);
  queue.dispose();
});

test("disposing an attachment drops pending sizes and late errors", async () => {
  let reject;
  let sent = 0;
  const queue = createTerminalResizeQueue(() => {
    sent++;
    return new Promise((_, fail) => (reject = fail));
  }, assert.fail);
  queue.request({ rows: 24, cols: 80 });
  queue.request({ rows: 30, cols: 120 });
  queue.dispose();
  queue.request({ rows: 40, cols: 160 });
  reject(Error("detached"));
  await setImmediate();
  assert.equal(sent, 1);
});
