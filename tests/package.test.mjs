import assert from "node:assert/strict";
import test from "node:test";
import { packagingPlan } from "../scripts/package.mjs";

test("packaging selects native installers and locks Cargo resolution", () => {
  assert.deepEqual(packagingPlan([], "darwin").args, [
    "build",
    "--ci",
    "--bundles",
    "app,dmg",
    "--",
    "--locked",
  ]);
  assert.deepEqual(packagingPlan([], "win32").args, [
    "build",
    "--ci",
    "--bundles",
    "nsis,msi",
    "--",
    "--locked",
  ]);
});
test("packaging keeps explicit options as separate arguments", () => {
  assert.deepEqual(
    packagingPlan(
      [
        "--debug",
        "--no-sign",
        "--bundles",
        "app",
        "--target",
        "universal-apple-darwin",
        "--dry-run",
      ],
      "darwin",
    ),
    {
      args: [
        "build",
        "--ci",
        "--bundles",
        "app",
        "--debug",
        "--target",
        "universal-apple-darwin",
        "--no-sign",
        "--",
        "--locked",
      ],
      dryRun: true,
    },
  );
});
test("packaging rejects cross-OS targets, invalid formats and incomplete options", () => {
  for (const args of [
    ["--target", "x86_64-pc-windows-msvc"],
    ["--bundles", "msi"],
    ["--bundles", ""],
    ["--target"],
    ["--bundles", "--debug"],
    ["--unknown"],
  ]) {
    assert.throws(() => packagingPlan(args, "darwin"));
  }
  assert.throws(() => packagingPlan(["--target", "aarch64-apple-darwin"], "win32"));
  assert.throws(() => packagingPlan([], "linux"));
});

test("local release packaging enables updater artifacts on supported OS architectures", () => {
  const options = ["--release", "uTerm-v1.2.3", "--repository", "test-owner/uterm", "--dry-run"];
  for (const [os, arch, triple, target, bundles] of [
    ["win32", "x64", "x86_64-pc-windows-msvc", "windows-x86_64", "nsis"],
    ["darwin", "arm64", "aarch64-apple-darwin", "darwin-aarch64", "app,dmg"],
    ["darwin", "x64", "x86_64-apple-darwin", "darwin-x86_64", "app,dmg"],
  ]) {
    const plan = packagingPlan(options, os, arch);
    assert.equal(plan.release.updateTarget, target);
    assert.equal(plan.release.repository, "test-owner/uterm");
    assert.deepEqual(plan.args, [
      "build",
      "--ci",
      "--bundles",
      bundles,
      "--target",
      triple,
      "--",
      "--locked",
    ]);
    assert.equal(plan.dryRun, true);
  }
  for (const incompatible of [
    ["--debug"],
    ["--no-sign"],
    ["--bundles", "app"],
    ["--target", "universal-apple-darwin"],
  ])
    assert.throws(() => packagingPlan([...options, ...incompatible], "darwin", "arm64"));
  assert.throws(() => packagingPlan(options, "win32", "arm64"));
  assert.throws(() =>
    packagingPlan(["--release", "v1.2.3", "--repository", "test-owner/uterm"], "win32", "x64"),
  );
  assert.throws(() => packagingPlan(["--repository", "test-owner/uterm"], "win32", "x64"));
});
