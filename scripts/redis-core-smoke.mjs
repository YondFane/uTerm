import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join, resolve } from "node:path";

const directory = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Provide an evidence directory outside the source tree");
mkdirSync(directory, { recursive: true });
const report = {
  sourceHeadSHA: process.env.PR_HEAD_SHA || "",
  testedMergeSHA: "",
  sourceTreeDirty: true,
  platform: platform(),
  architecture: arch(),
  system: release(),
  checks: [],
  passed: false,
  nativeRedisUIAcceptance: false,
  windowsRedisUIAcceptance: false,
};
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  return { status: result.status, output };
}
function required(command, args) {
  const result = run(command, args);
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  return result.output.trim();
}
try {
  report.testedMergeSHA = required("git", ["rev-parse", "HEAD"]);
  report.sourceHeadSHA ||= report.testedMergeSHA;
  report.sourceTreeDirty = required("git", ["status", "--porcelain"]) !== "";
  const serverPath = required("sh", ["-c", "command -v redis-server"]);
  report.redis = {
    server: required("redis-server", ["--version"]),
    cli: required("redis-cli", ["--version"]),
    serverSHA256: createHash("sha256").update(readFileSync(serverPath)).digest("hex"),
    sourceSHA256: process.env.UTERM_REDIS_SOURCE_SHA256 || null,
    openssl: required("openssl", ["version"]),
  };
  report.rust = required("rustc", ["--version"]);
  report.cargo = required("cargo", ["--version"]);
  for (const [name, command, args, count] of [
    ["redis-service", "pnpm", ["test:redis"], 11],
    [
      "redis-host",
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        "crates/uterm-core/Cargo.toml",
        "--test",
        "redis_host",
      ],
      2,
    ],
    [
      "redis-client",
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        "crates/uterm-core/Cargo.toml",
        "--test",
        "redis_client",
      ],
      5,
    ],
  ]) {
    const { status, output } = run(command, args);
    const log = `${name}.log`;
    writeFileSync(join(directory, log), output);
    const tests = [...output.matchAll(/^test (\S+) \.\.\. ok\r?$/gm)].map((match) => match[1]);
    const passed = status === 0 && tests.length === count && /0 failed; 0 ignored/.test(output);
    report.checks.push({ command: [command, ...args], exitCode: status, log, tests, passed });
    process.stdout.write(`${name}: ${passed ? "passed" : "failed"} (${tests.length} tests)\n`);
  }
  report.passed = report.checks.every((check) => check.passed);
} catch (error) {
  report.failure = String(error.message);
} finally {
  writeFileSync(join(directory, "redis-core.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (!report.passed) process.exitCode = 1;
