import { spawn, spawnSync } from "node:child_process";
import {
  openSync,
  closeSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir, release, arch } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { startResourceSampler } from "./client-resource-sampler.mjs";

assert.equal(process.platform, "darwin", "This check needs an actual Mac desktop");
assert.equal(spawnSync("launchctl", ["print", `gui/${process.getuid()}`]).status, 0);
assert.equal(spawnSync("pgrep", ["-x", "WindowServer"]).status, 0);
assert.equal(
  spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout.trim(),
  "",
  "Performance evidence needs clean source",
);
const output = resolve("ci-evidence/performance-native");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "uterm-native-qa-performance-"));
const reportPath = join(output, "native-performance.json");
const stdout = openSync(join(output, "stdout.log"), "w");
const stderr = openSync(join(output, "stderr.log"), "w");
let successful = false;
const cleanupErrors = [];
const child = spawn(
  resolve("macos/.build/qa/UTermNativeQA.app/Contents/MacOS/UTermNativeQA"),
  ["--qa-data-root", root, "--performance-smoke-report", reportPath],
  { stdio: ["ignore", stdout, stderr] },
);
closeSync(stdout);
closeSync(stderr);
const exited = new Promise((done, reject) => {
  child.once("exit", (code, signal) => done({ code, signal }));
  child.once("error", reject);
});
const sampler = startResourceSampler(
  child.pid,
  join(root, "performance-phase.json"),
  join(output, "resources-native.json"),
);
let timeout;
try {
  const result = await Promise.race([
    exited,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Error("Native performance app timed out")), 600000);
    }),
  ]);
  assert.equal(result.code, 0, JSON.stringify(result));
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert(!report.failure && !report.cleanupError, JSON.stringify(report));
  assert(
    report.explicitCloseAndIdleHostShutdown && report.coreReady && !report.productionDataAccess,
  );
  assert.equal(report.bundleIdentifier, "sh.uterm.desktop.qa.native");
  assert(
    !existsSync(join(root, "local-daemon-v1/endpoint.json")),
    "Fixture host endpoint survived explicit close",
  );
  const tested = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(report.sourceSHA, tested);
  assert.equal(report.sourceHeadSHA, process.env.PR_HEAD_SHA || tested);
  for (const image of report.captures)
    assert(
      readFileSync(join(output, image))
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    );
  Object.assign(report, {
    passed: true,
    testedMergeSHA: tested,
    sourceTreeDirty: false,
    processExitCode: result.code,
    architecture: arch(),
    system: release(),
  });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  successful = true;
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) {
    spawnSync("sample", [String(child.pid), "3", "-file", join(output, "timeout-sample.txt")], {
      timeout: 10000,
    });
    child.kill("SIGKILL");
    await exited;
  }
  try {
    await sampler.stop();
  } catch (error) {
    cleanupErrors.push(String(error));
  }
  if (existsSync(join(root, "local-daemon-v1/endpoint.json"))) {
    const target = resolve(process.env.CARGO_TARGET_DIR || "crates/uterm-core/target");
    const cli = join(target, "debug/uterm-core-contract");
    const request = (method, params = null) => {
      const result = spawnSync(cli, ["--serve", join(root, "shared-state-v1")], {
        input: JSON.stringify({ version: 1, id: "performance-cleanup", method, params }) + "\n",
        encoding: "utf8",
        timeout: 30000,
      });
      assert.equal(result.status, 0, result.stderr);
      const reply = JSON.parse(result.stdout);
      assert(!reply.error, JSON.stringify(reply.error));
      return reply.result;
    };
    try {
      for (const session of request("host.status").sessions)
        request("host.close", { id: session.spec.id, generation: session.generation });
      request("host.shutdownIdle");
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  }
  if (existsSync(join(root, "local-daemon-v1/endpoint.json")))
    cleanupErrors.push("Private host endpoint remains");
  writeFileSync(
    join(output, "cleanup.json"),
    JSON.stringify({ successful, cleanupErrors, productionDataAccess: false }, null, 2),
  );
  if (!cleanupErrors.length) rmSync(root, { recursive: true, force: true });
  if (!successful || cleanupErrors.length) process.exitCode = 1;
}
