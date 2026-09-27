import assert from "node:assert/strict";
import test from "node:test";
import { quotaAgent, remainingUsage } from "../src/lib/usage.ts";

test("quota lookup follows the Agent session instead of its workspace group", () => {
  assert.equal(quotaAgent("codex"), "codex");
  assert.equal(quotaAgent("claude"), "claude");
  assert.equal(quotaAgent("kimi"), "kimi");
  assert.equal(quotaAgent("grok"), "grok");
  assert.equal(quotaAgent("gemini"), null);
  assert.equal(quotaAgent(undefined), null);
});

test("remaining usage uses the tightest available quota window", () => {
  assert.deepEqual(
    remainingUsage([
      { label: "主要额度", percent: 37.4 },
      { label: "次要额度", percent: 72.8 },
    ]),
    { percent: 27, title: "主要额度剩余 63%；次要额度剩余 27%" },
  );
});

test("remaining usage stays hidden without a valid quota window", () => {
  assert.equal(remainingUsage([]), null);
  assert.equal(remainingUsage([{ label: "主要额度", percent: Number.NaN }]), null);
  assert.equal(remainingUsage([{ label: "主要额度", percent: 101 }]), null);
});
