import test from "node:test";
import assert from "node:assert/strict";
import {
  registerTerminalPerformanceProbe,
  terminalPerformanceSnapshot,
} from "../src/lib/terminal-performance-qa.ts";

test("late view cleanup preserves its replacement and full-range sequence", () => {
  const first = registerTerminalPerformanceProbe("same-session", () => ({ sequence: "1" }));
  const sequence = ((1n << 64n) - 1n).toString();
  const second = registerTerminalPerformanceProbe("same-session", () => ({ sequence }));
  first();
  assert.equal(terminalPerformanceSnapshot("same-session").sequence, sequence);
  second();
  assert.equal(terminalPerformanceSnapshot("same-session"), undefined);
});
