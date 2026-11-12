import test from "node:test";
import assert from "node:assert/strict";
import {
  registerTerminalPerformanceProbe,
  terminalPerformanceSnapshot,
  windowsPerformancePromptReady,
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

test("Windows performance waits for the acknowledged parent prompt rather than an earlier child marker", () => {
  const ready = {
    cursorLine: "C:\\QA\\project>",
    writable: true,
    frames: 12,
    acknowledgedFrames: 12,
  };
  assert.equal(windowsPerformancePromptReady(ready, "c:/qa/project"), true);
  assert.equal(windowsPerformancePromptReady(undefined, "C:\\QA\\project"), false);
  for (const change of [
    { cursorLine: "TUI_02" },
    { cursorLine: "C:\\QA\\project>powershell.exe -Command child" },
    { cursorLine: "C:\\QA\\other>" },
    { writable: false },
    { acknowledgedFrames: 11 },
  ])
    assert.equal(windowsPerformancePromptReady({ ...ready, ...change }, "C:\\QA\\project"), false);
  const unicode = "C:\\QA\\项目 with spaces";
  assert.equal(
    windowsPerformancePromptReady({ ...ready, cursorLine: unicode + ">" }, unicode),
    true,
  );
});
