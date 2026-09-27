import test from "node:test";
import assert from "node:assert/strict";
import { sessionSyncErrorMessage } from "../src/lib/session-sync.ts";

test("background session connection timeouts do not display a banner", () => {
  assert.equal(sessionSyncErrorMessage("connection timed out"), "");
  assert.equal(sessionSyncErrorMessage(new Error("connection timed out")), "");
  assert.equal(sessionSyncErrorMessage(" Connection timed out. "), "");
});

test("other session sync failures remain visible", () => {
  assert.equal(
    sessionSyncErrorMessage("authentication failed"),
    "无法同步本机会话：authentication failed",
  );
  assert.equal(
    sessionSyncErrorMessage(new Error("invalid snapshot")),
    "无法同步本机会话：invalid snapshot",
  );
});
