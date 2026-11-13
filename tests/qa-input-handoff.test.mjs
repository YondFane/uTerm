import test from "node:test";
import assert from "node:assert/strict";
import { createInputTakeoverHandoff } from "../scripts/qa-input-handoff.mjs";

const owner = { sessionID: "actual-session", generation: "actual-generation", hostPID: 42 };

test("slow peer startup and capture do not consume the owner's takeover assertion deadline", () => {
  const handoff = createInputTakeoverHandoff();
  let now = 0;
  let ownerAssertionStarted;
  const acknowledge = (paths) => {
    if (paths.includes("owner.ack")) ownerAssertionStarted = now;
  };
  const ready = handoff.observe("input-owner-ready", "owner.ack", owner);
  assert.equal(ready.startViewer, true);
  acknowledge(ready.acknowledgements);
  now = 26000;
  assert.equal(handoff.observe("input-viewer-gpu-readonly", "gpu.ack", owner), null);
  now = 32000; // Observed Mac startup/renderer/capture interval exceeds the unchanged 30s assertion.
  assert.equal(ownerAssertionStarted, undefined);
  const peer = handoff.observe("input-viewer-readonly", "viewer.ack", { ...owner });
  assert.deepEqual(peer.acknowledgements, ["owner.ack", "viewer.ack"]);
  assert.equal(peer.startViewer, false);
  acknowledge(peer.acknowledgements);
  now += 100;
  assert.equal(now - ownerAssertionStarted, 100);
  assert(now - ownerAssertionStarted < 30000);
});

test("cross-session, stale-generation and different-host peers cannot release either side", () => {
  for (const changed of [
    { sessionID: "other-session" },
    { generation: "old-generation" },
    { hostPID: 43 },
  ]) {
    const handoff = createInputTakeoverHandoff();
    handoff.observe("input-owner-ready", "owner.ack", owner);
    assert.throws(() =>
      handoff.observe("input-viewer-readonly", "viewer.ack", { ...owner, ...changed }),
    );
    assert.deepEqual(
      handoff.observe("input-viewer-readonly", "viewer.ack", owner).acknowledgements,
      ["owner.ack", "viewer.ack"],
    );
  }
});

test("out-of-order, duplicate, replayed and shared-ack scenes remain rejected", () => {
  const handoff = createInputTakeoverHandoff();
  assert.throws(() => handoff.observe("input-viewer-readonly", "viewer.ack", owner));
  handoff.observe("input-owner-ready", "owner.ack", owner);
  assert.throws(() => handoff.observe("input-owner-ready", "another.ack", owner));
  assert.throws(() => handoff.observe("input-viewer-readonly", "owner.ack", owner));
  handoff.observe("input-viewer-readonly", "viewer.ack", owner);
  assert.throws(() => handoff.observe("input-viewer-readonly", "viewer.ack", owner));
  assert.throws(() => handoff.observe("input-owner-ready", "owner.ack", owner));
});

test("invalid process IDs and missing opaque identities never start the handoff", () => {
  for (const changed of [
    { sessionID: "" },
    { generation: "" },
    { hostPID: "42" },
    { hostPID: 0 },
    { hostPID: 1.5 },
    { hostPID: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() =>
      createInputTakeoverHandoff().observe("input-owner-ready", "owner.ack", {
        ...owner,
        ...changed,
      }),
    );
  }
});
