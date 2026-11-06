import test from "node:test";
import assert from "node:assert/strict";
import {
  cpuSeconds,
  parsePs,
  ownedProcesses,
  summarizeSamples,
} from "../scripts/client-resource-sampler.mjs";

test("sampling parses cumulative CPU and selects only the measured app/host trees", () => {
  assert.equal(cpuSeconds("1-02:03:04.25"), 93784.25);
  const rows = parsePs(
    "10 1 100 0:01.50\n11 10 20 0:00.25\n20 1 30 0:02.00\n21 20 40 0:00.10\n99 1 900 0:09.00\ninvalid",
  );
  assert.deepEqual(
    ownedProcesses(rows, 10, 20).map((value) => value.pid),
    [10, 11, 20, 21],
  );
  assert.equal(rows[0].rssBytes, 102400);
});

test("CPU snapshots and process disappearance do not turn cumulative counters into leaks", () => {
  const result = summarizeSamples([
    {
      phase: "terminal",
      processes: [
        { pid: 10, rssBytes: 100, cpuSeconds: 4 },
        { pid: 11, rssBytes: 20, cpuSeconds: 1 },
      ],
    },
    { phase: "terminal", processes: [{ pid: 10, rssBytes: 110, cpuSeconds: 4.5 }] },
    { phase: "idle-soak", processes: [{ pid: 10, rssBytes: 105, cpuSeconds: 4.6 }] },
  ]);
  assert.equal(result.terminal.peakRSSBytes, 120);
  assert.equal(result.terminal.observedCPUSeconds, 0.5);
  assert.ok(Math.abs(result["idle-soak"].observedCPUSeconds - 0.1) < 1e-10);
});
