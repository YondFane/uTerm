import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";

export async function waitForOwnedHostExit(endpoint, pid, timeoutMilliseconds = 10000) {
  assert(Number.isInteger(pid) && pid > 1, "Missing authenticated fixture host PID");
  const started = performance.now();
  while (true) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      alive = false;
    }
    if (!existsSync(endpoint) && !alive)
      return {
        endpointRemoved: true,
        hostPIDExited: true,
        waitMilliseconds: performance.now() - started,
      };
    assert(
      performance.now() - started < timeoutMilliseconds,
      "Owned host endpoint or process survived explicit close/shutdown",
    );
    await pause(25);
  }
}
