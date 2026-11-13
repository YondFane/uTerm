import assert from "node:assert/strict";

function identity(checks) {
  assert.equal(typeof checks?.sessionID, "string", "Missing actual session ID");
  assert(checks.sessionID.length > 0, "Missing actual session ID");
  assert.equal(typeof checks.generation, "string", "Missing actual generation");
  assert(checks.generation.length > 0, "Missing actual generation");
  assert(Number.isSafeInteger(checks.hostPID) && checks.hostPID > 0, "Invalid actual host PID");
  return { sessionID: checks.sessionID, generation: checks.generation, hostPID: checks.hostPID };
}

export function createInputTakeoverHandoff() {
  let owner;
  let released = false;
  return {
    observe(scene, ack, checks) {
      if (scene !== "input-owner-ready" && scene !== "input-viewer-readonly") return null;
      assert.equal(typeof ack, "string", "Missing scene acknowledgement");
      assert(ack.length > 0, "Missing scene acknowledgement");
      if (scene === "input-owner-ready") {
        assert(!owner && !released, "Duplicate owner-ready scene");
        owner = { ack, identity: identity(checks) };
        // Start the peer while withholding the owner's takeover assertion clock.
        // 启动观察者，暂不放行旧所有者的接管断言计时。
        return { acknowledgements: [], startViewer: true };
      }
      assert(owner && !released, "Viewer readiness requires the pending actual owner");
      const viewer = identity(checks);
      for (const key of ["sessionID", "generation", "hostPID"]) {
        assert.equal(viewer[key], owner.identity[key], `Viewer changed ${key}`);
      }
      assert.notEqual(ack, owner.ack, "Peer scenes must have distinct acknowledgements");
      // Both screenshots are complete; now release the assertion and real takeover together.
      // 两端截图已完成，再同时放行断言与真实接管操作。
      const acknowledgements = [owner.ack, ack];
      owner = undefined;
      released = true;
      return { acknowledgements, startViewer: false };
    },
  };
}
