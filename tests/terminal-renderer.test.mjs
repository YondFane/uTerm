import test from "node:test";
import assert from "node:assert/strict";
import { attachTerminalRenderer } from "../src/lib/terminal-renderer.ts";

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
