import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/install/install.sh");
function run(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "uterm-install-test-"));
  const bin = join(root, "bin");
  const home = join(root, "home with spaces");
  mkdirSync(bin);
  mkdirSync(home);
  const mocks = {
    uname: 'if [ "$1" = -s ]; then echo "${TEST_OS:-Darwin}"; else echo "${TEST_ARCH:-arm64}"; fi',
    sysctl: 'echo "${TEST_TRANSLATED:-0}"',
    curl: 'printf "%s\\n" "$*" >> "$TEST_ROOT/downloads"; [ "${TEST_FAIL:-0}" = 0 ] || exit 22; while [ "$1" != -o ]; do shift; done; echo "{}" > "$2"',
    plutil: 'echo "${TEST_VERSION:-0.1.6}"',
    hdiutil:
      'if [ "$1" = attach ]; then while [ "$1" != -mountpoint ]; do shift; done; mkdir -p "$2/uTerm.app"; echo app > "$2/uTerm.app/payload"; else echo detached > "$TEST_ROOT/detached"; fi',
    ditto: 'cp -R "$1" "$2"',
  };
  for (const [name, body] of Object.entries(mocks)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  if (options.existing) mkdirSync(join(home, "Applications/uTerm.app"), { recursive: true });
  const fixture = join(root, "install.sh");
  writeFileSync(
    fixture,
    readFileSync(script, "utf8").replace(
      "! -e /Applications/uTerm.app",
      `! -e "${root}/system/uTerm.app"`,
    ),
  );
  const result = spawnSync("bash", [fixture], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      TEST_ROOT: root,
      ...options.env,
    },
  });
  const state = {
    ...result,
    installed: existsSync(join(home, "Applications/uTerm.app/payload")),
    detached: existsSync(join(root, "detached")),
    downloads: existsSync(join(root, "downloads"))
      ? readFileSync(join(root, "downloads"), "utf8")
      : "",
  };
  rmSync(root, { recursive: true, force: true });
  return state;
}
const skip = process.platform === "win32" || process.getuid?.() === 0;
test(
  "macOS installer selects native and Rosetta assets and handles paths with spaces",
  { skip },
  () => {
    for (const [arch, translated, target] of [
      ["arm64", "0", "aarch64"],
      ["x86_64", "0", "x86_64"],
      ["x86_64", "1", "aarch64"],
    ]) {
      const result = run({ env: { TEST_ARCH: arch, TEST_TRANSLATED: translated } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.installed, true);
      assert.equal(result.detached, true);
      assert.match(result.downloads, new RegExp(`uTerm-0.1.6-darwin-${target}\\.dmg`));
    }
  },
);
test(
  "macOS installer rejects unsupported hosts, malformed feeds, failed downloads and existing apps",
  { skip },
  () => {
    for (const options of [
      { env: { TEST_OS: "Linux" } },
      { env: { TEST_ARCH: "other" } },
      { env: { TEST_VERSION: "../bad" } },
      { env: { TEST_FAIL: "1" } },
      { existing: true },
    ]) {
      const result = run(options);
      assert.notEqual(result.status, 0);
      assert.equal(result.installed, false);
    }
  },
);

const { installerCommand, main } = await import("../scripts/install/cli.mjs");
test("npm entry point invokes bundled scripts without a shell and propagates failures", () => {
  assert.equal(installerCommand("darwin").command, "/bin/bash");
  const windows = installerCommand("win32", { SystemRoot: "C:\\Windows" });
  assert.equal(windows.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(windows.args.at(-2), "-File");
  assert.ok(windows.args.at(-1).endsWith("install.ps1"));
  assert.throws(() => installerCommand("linux"), /Only macOS/);
  assert.throws(() => installerCommand("win32", {}), /Missing Windows/);
  assert.equal(
    main([], "darwin", (command, args, options) => {
      assert.equal(options.shell, false);
      assert.ok(args[0].endsWith("install.sh"));
      return { status: 7 };
    }),
    7,
  );
  assert.equal(
    main(["--help"], "linux", () => {
      throw new Error("must not execute");
    }),
    0,
  );
  assert.equal(
    main(["--unknown"], "darwin", () => {
      throw new Error("must not execute");
    }),
    1,
  );
});
