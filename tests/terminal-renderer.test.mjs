import test from "node:test";
import assert from "node:assert/strict";
import {
  attachTerminalRenderer,
  createTerminalRendererPool,
} from "../src/lib/terminal-renderer.ts";

function fixture({ creationFails = false, activationFails = false } = {}) {
  const events = [];
  let onLoss;
  const renderer = {
    activate() {},
    onContextLoss(listener) {
      onLoss = listener;
      return {
        dispose() {
          events.push("unsubscribe");
          onLoss = undefined;
        },
      };
    },
    dispose() {
      events.push("fallback");
    },
  };
  const terminal = {
    loadAddon(addon) {
      assert.equal(addon, renderer);
      events.push("activate");
      if (activationFails) throw Error("WebGL2 unavailable");
    },
  };
  const dispose = attachTerminalRenderer(terminal, () => {
    if (creationFails) throw Error("GPU unavailable");
    return renderer;
  });
  return { events, dispose, loseContext: () => onLoss?.() };
}

test("GPU rendering is activated without touching terminal data or selection", () => {
  const value = fixture();
  assert.deepEqual(value.events, ["activate"]);
  value.dispose();
  assert.deepEqual(value.events, ["activate", "unsubscribe", "fallback"]);
  value.dispose();
  value.loseContext();
  assert.equal(value.events.length, 3);
});

test("context loss restores DOM rendering once and removes the loss listener", () => {
  const value = fixture();
  value.loseContext();
  assert.deepEqual(value.events, ["activate", "unsubscribe", "fallback"]);
  value.loseContext();
  value.dispose();
  assert.equal(value.events.length, 3);
});

test("unsupported GPUs and activation failures leave the DOM fallback usable", () => {
  const unsupported = fixture({ creationFails: true });
  unsupported.dispose();
  assert.deepEqual(unsupported.events, []);
  const failed = fixture({ activationFails: true });
  assert.deepEqual(failed.events, ["activate", "unsubscribe", "fallback"]);
  failed.loseContext();
  failed.dispose();
  assert.equal(failed.events.length, 3);
});

function pooled(pool, fail = false) {
  const counts = { created: 0, disposed: 0 };
  let loss;
  const terminal = { loadAddon() {} };
  const handle = pool.register(terminal, () => {
    counts.created++;
    if (fail) throw Error("GPU unavailable");
    return {
      activate() {},
      onContextLoss(listener) {
        loss = listener;
        return {
          dispose() {
            loss = undefined;
          },
        };
      },
      dispose() {
        counts.disposed++;
      },
    };
  });
  return { ...handle, counts, loseContext: () => loss?.() };
}

test("rapid switches reuse GPU renderers and cancel stale expiry timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pool = createTerminalRendererPool();
  const a = pooled(pool),
    b = pooled(pool);
  for (let i = 0; i < 20; i++) {
    a.setVisible(true);
    b.setVisible(false);
    t.mock.timers.tick(100);
    a.setVisible(false);
    b.setVisible(true);
    t.mock.timers.tick(100);
  }
  assert.deepEqual(a.counts, { created: 1, disposed: 0 });
  assert.deepEqual(b.counts, { created: 1, disposed: 0 });
  t.mock.timers.tick(15000);
  assert.equal(a.counts.disposed, 1);
  assert.equal(b.counts.disposed, 0);
  a.setVisible(true);
  assert.equal(a.counts.created, 2);
  a.dispose();
  b.dispose();
  t.mock.timers.tick(20000);
  assert.deepEqual(a.counts, { created: 2, disposed: 2 });
  assert.deepEqual(b.counts, { created: 1, disposed: 1 });
});

test("idle cache evicts the oldest hidden pane without evicting visible split panes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pool = createTerminalRendererPool(2);
  const visible = pooled(pool);
  visible.setVisible(true);
  const panes = Array.from({ length: 4 }, () => pooled(pool));
  for (const pane of panes) {
    pane.setVisible(true);
    pane.setVisible(false);
  }
  assert.deepEqual(
    panes.map((p) => p.counts.disposed),
    [1, 1, 0, 0],
  );
  assert.equal(visible.counts.disposed, 0);
  panes[2].setVisible(true);
  assert.equal(panes[2].counts.created, 1);
  panes[0].setVisible(true);
  assert.equal(panes[0].counts.created, 2);
  t.mock.timers.tick(15000);
  assert.equal(visible.counts.disposed, 0);
  assert.equal(panes[2].counts.disposed, 0);
  visible.dispose();
  panes.forEach((p) => p.dispose());
});

test("context loss and failed GPU activation leave no idle cache entries or double disposal", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pool = createTerminalRendererPool(0);
  const a = pooled(pool),
    failed = pooled(pool, true);
  a.setVisible(true);
  a.loseContext();
  assert.equal(a.counts.disposed, 1);
  a.setVisible(false);
  a.setVisible(true);
  assert.equal(a.counts.created, 2);
  a.setVisible(false);
  assert.equal(a.counts.disposed, 2);
  failed.setVisible(true);
  failed.setVisible(false);
  failed.setVisible(true);
  failed.dispose();
  assert.deepEqual(failed.counts, { created: 2, disposed: 0 });
  a.dispose();
  t.mock.timers.tick(20000);
  assert.equal(a.counts.disposed, 2);
});
