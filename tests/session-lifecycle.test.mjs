import test from "node:test";
import assert from "node:assert/strict";
import { autoCloseAgent, closeAttachedSession } from "../src/lib/session-lifecycle.ts";

test("only successful Agent exits auto-close, preserving crash diagnostics", () => {
  assert.equal(autoCloseAgent("opencode", 0), true);
  for (const code of [1, 130, null]) assert.equal(autoCloseAgent("codex", code), false);
  assert.equal(autoCloseAgent(undefined, 0), false);
});

test("failed termination retains attachment and every retry must terminate successfully", async () => {
  const connection = { closed: false, ready: Promise.resolve() };
  let attempts = 0;
  const fail = async () => {
    attempts++;
    throw new Error("offline");
  };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(closeAttachedSession(connection, fail), /offline/);
    assert.equal(connection.closed, false);
  }
  assert.equal(attempts, 2);
  assert.equal(
    await closeAttachedSession(connection, async () => {
      attempts++;
    }),
    true,
  );
  assert.equal(connection.closed, true);
  assert.equal(await closeAttachedSession(connection, fail), false);
  assert.equal(attempts, 3);
});

test("closing waits for attachment startup and rejects duplicate in-flight requests", async () => {
  let ready;
  const connection = {
    closed: false,
    ready: new Promise((resolve) => {
      ready = resolve;
    }),
  };
  let terminated = false;
  const pending = closeAttachedSession(connection, async () => {
    terminated = true;
  });
  assert.equal(terminated, false);
  assert.equal(await closeAttachedSession(connection, async () => {}), false);
  ready();
  assert.equal(await pending, true);
  assert.equal(terminated, true);
});
