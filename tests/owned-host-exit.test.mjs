import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForOwnedHostExit } from "../scripts/owned-host-exit.mjs";

test("cleanup waits for both a delayed endpoint unlink and the actual owned process exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "uterm-native-qa-host-exit-"));
  const endpoint = join(root, "endpoint.json");
  writeFileSync(endpoint, "owned fixture\n");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    process.send('ready');
      process.once('message', () => {
        setTimeout(() => require('node:fs').unlinkSync(process.argv[1]), 30);
        setTimeout(() => process.exit(0), 200);
      });
  `,
      endpoint,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
    });
    const waiting = waitForOwnedHostExit(endpoint, child.pid);
    child.send("close owned fixture");
    const result = await waiting;
    assert(result.endpointRemoved && result.hostPIDExited && result.waitMilliseconds >= 100);
    assert.equal(await closed, 0);
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup times out without terminating a still-running process", async () => {
  const root = mkdtempSync(join(tmpdir(), "uterm-native-qa-host-exit-"));
  try {
    await assert.rejects(
      waitForOwnedHostExit(join(root, "absent"), process.pid, 50),
      /survived explicit/,
    );
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
