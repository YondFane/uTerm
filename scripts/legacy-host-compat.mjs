import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release, version } from "node:os";
import { join, resolve } from "node:path";

const evidence = resolve(process.argv[2] ?? "ci-evidence/legacy-host");
mkdirSync(evidence, { recursive: true });
mkdirSync("layout-qa.local", { recursive: true });
const work = mkdtempSync(resolve("layout-qa.local/release-host-"));
const source = join(work, "source");
mkdirSync(source);
const baseline = JSON.parse(readFileSync("shared/contracts/tauri-baseline.json")).baseline_release;
if (!/^[a-f0-9]{40}$/.test(baseline)) throw Error("Invalid recorded release baseline");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw Error(`${command} ${args.join(" ")}: ${result.error ?? result.stderr ?? result.status}`);
  return result.stdout?.trim();
}
function logged(name, args, env = process.env) {
  const fd = openSync(join(evidence, name), "w");
  try {
    run("cargo", args, { env, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
}
function sourceHashes(path, prefix = "") {
  return Object.fromEntries(
    readdirSync(path, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((item) => {
        const name = join(prefix, item.name);
        if (item.isDirectory()) return Object.entries(sourceHashes(join(path, item.name), name));
        if (!item.isFile()) throw Error(`Nonregular archived source: ${name}`);
        return [[name, hash(readFileSync(join(path, item.name)))]];
      }),
  );
}
const report = {
  passed: false,
  sourceHeadSHA: process.env.PR_HEAD_SHA ?? run("git", ["rev-parse", "HEAD"]),
  testedMergeSHA: run("git", ["rev-parse", "HEAD"]),
  sourceTreeDirty: Boolean(run("git", ["status", "--porcelain", "--untracked-files=no"])),
  platform: platform(),
  architecture: arch(),
  system: { release: release(), version: version() },
  baselineRelease: baseline,
  publishedInstallerBinary: false,
  scenario:
    "Real helper compiled from unchanged recorded release source; not installer upgrade acceptance",
};
try {
  const available = spawnSync("git", ["cat-file", "-e", `${baseline}^{commit}`]);
  if (available.status !== 0) run("git", ["fetch", "--no-tags", "--depth=1", "origin", baseline]);
  const archive = join(work, "source.tar");
  run("git", ["archive", "--format=tar", `--output=${archive}`, baseline, "crates/utermd-local"]);
  report.sourceArchiveSHA256 = hash(readFileSync(archive));
  run("tar", ["-xf", archive, "-C", source]);
  const before = sourceHashes(source);
  writeFileSync(
    join(evidence, "release-source-hashes.json"),
    JSON.stringify(before, null, 2) + "\n",
  );
  report.toolchain = { rust: run("rustc", ["--version"]), cargo: run("cargo", ["--version"]) };
  const target = resolve(process.env.UTERM_REFERENCE_TARGET ?? join(work, "target"));
  logged("release-helper-build.log", [
    "build",
    "--locked",
    "--manifest-path",
    join(source, "crates/utermd-local/Cargo.toml"),
    "--target-dir",
    target,
    "--bin",
    "utermd-local",
  ]);
  if (JSON.stringify(before) !== JSON.stringify(sourceHashes(source)))
    throw Error("Release source changed during build");
  const binary = join(
    target,
    "debug",
    platform() === "win32" ? "utermd-local.exe" : "utermd-local",
  );
  if (!existsSync(binary)) throw Error("Missing reference helper binary");
  report.releaseBinarySHA256 = hash(readFileSync(binary));
  logged("current-helper-build.log", [
    "build",
    "--locked",
    "--manifest-path",
    "crates/utermd-local/Cargo.toml",
    "--bin",
    "utermd-local",
  ]);
  const detail = join(evidence, "process-report.json");
  logged(
    "real-process-test.log",
    [
      "test",
      "--locked",
      "--manifest-path",
      "crates/uterm-core/Cargo.toml",
      "--test",
      "host",
      "immutable_release_host_preserves_real_binary_replay_and_upgrades_only_after_close",
      "--",
      "--include-ignored",
      "--exact",
      "--nocapture",
    ],
    { ...process.env, UTERM_RELEASE_HOST_BINARY: binary, UTERM_COMPAT_REPORT_FILE: detail },
  );
  report.process = JSON.parse(readFileSync(detail));
  if (!report.process.passed || report.process.binaryFramesAcknowledged < 1)
    throw Error("Incomplete process report");
  if (hash(readFileSync(binary)) !== report.releaseBinarySHA256)
    throw Error("Reference binary changed");
  report.passed = true;
} catch (error) {
  report.failure = String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
