import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collect,
  manifest,
  releaseBase,
  releaseConfig,
  releaseVersion,
  releaseNotes,
  targets,
  supportedTargets,
  feedFilename,
} from "../scripts/release.mjs";

process.env.GITHUB_REPOSITORY = "test-owner/uterm";

function windowsGitBash(gitPaths, exists = existsSync) {
  for (const gitPath of gitPaths) {
    for (let directory = win32.dirname(gitPath); ; directory = win32.dirname(directory)) {
      const candidate = win32.join(directory, "bin", "bash.exe");
      if (exists(candidate)) return candidate;
      if (directory === win32.dirname(directory)) break;
    }
  }
  throw new Error("Git Bash was not found beside the installed Git executables");
}

test("Windows Git Bash discovery supports cmd and mingw64 installations", () => {
  const expected = String.raw`C:\Program Files\Git\bin\bash.exe`;
  for (const suffix of [
    String.raw`cmd\git.exe`,
    String.raw`bin\git.exe`,
    String.raw`mingw64\bin\git.exe`,
  ]) {
    assert.equal(
      windowsGitBash(
        [win32.join(String.raw`C:\Program Files\Git`, suffix)],
        (path) => path === expected,
      ),
      expected,
    );
  }
  assert.throws(
    () => windowsGitBash([String.raw`C:\missing\git.exe`], () => false),
    /Git Bash was not found/,
  );
});

test("release workflow accepts only version tags on the release branch", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/uterm-release.yml", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const block = workflow.split("      - name: Require a version tag from release\n")[1];
  assert.ok(block, "source validation step is required");
  const script = block
    .split("        run: |\n")[1]
    .split("\n  build:")[0]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  const bash =
    process.platform === "win32"
      ? windowsGitBash(
          execFileSync("where.exe", ["git"], { encoding: "utf8" }).trim().split(/\r?\n/),
        )
      : "bash";
  const root = mkdtempSync(join(tmpdir(), "uterm-release-source-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const run = (tag) =>
    execFileSync(bash, ["-e", "-c", script], {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env, RELEASE_TAG: tag },
    });
  try {
    git("init", "-b", "release");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("commit", "--allow-empty", "-m", "initial");
    git("tag", "-a", "uTerm-v1.0.0", "-m", "version");
    git("commit", "--allow-empty", "-m", "later release work");
    git("remote", "add", "origin", root);
    run("uTerm-v1.0.0");
    git("switch", "-c", "main-x");
    git("commit", "--allow-empty", "-m", "unreleased work");
    git("tag", "uTerm-v1.0.1");
    assert.throws(() => run("uTerm-v1.0.1"), /Release tag must point/);
    assert.throws(() => run("uTerm-v1.0.2"));
    assert.throws(() => run("release"), /Invalid release tag/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release channels reject native tags, prereleases, and invalid Windows versions", () => {
  assert.equal(releaseVersion("uTerm-v1.2.3"), "1.2.3");
  for (const tag of [
    "v1.2.3",
    "uTerm-v01.2.3",
    "uTerm-v1.2.3-beta.1",
    "uTerm-v1.2.65536",
    "uTerm-v1.2.3/other",
  ])
    assert.throws(() => releaseVersion(tag));
  assert.throws(() => releaseConfig("uTerm-v1.2.3", "path/to/key", "darwin"));
  const key = Buffer.from(
    `untrusted comment: test\n${Buffer.alloc(42).toString("base64")}`,
  ).toString("base64");
  assert.equal(releaseConfig("uTerm-v1.2.3", key, "darwin").identifier, "sh.uterm.desktop");
  assert.deepEqual(releaseConfig("uTerm-v1.2.3", key, "darwin").plugins.updater.endpoints, [
    "https://github.com/test-owner/uterm/releases/download/uTerm-updates/latest-darwin-{{arch}}.json",
  ]);
  for (const repository of ["", "owner", "owner/repo/other", "../repo", "owner/repo?query"])
    assert.throws(() => releaseBase(repository));
  assert.equal(releaseConfig("uTerm-v1.2.3", key, "darwin").bundle.macOS.signingIdentity, "-");
  const unsigned = releaseConfig("uTerm-v1.2.3", key, "win32");
  assert.equal(unsigned.bundle.windows, undefined);
  assert.equal(unsigned.bundle.createUpdaterArtifacts, true);
  assert.equal(unsigned.plugins.updater.pubkey, key);
  assert.throws(() => releaseConfig("uTerm-v1.2.3", "", "win32"));
  assert.throws(() => releaseConfig("uTerm-v1.2.3", key, "win32", "invalid"));
  const thumbprint = "A".repeat(40);
  assert.equal(
    releaseConfig("uTerm-v1.2.3", key, "win32", thumbprint).bundle.windows.certificateThumbprint,
    thumbprint,
  );
});
test("release notes load the selected version and reject a missing translation", (context) => {
  // Isolate note validation from the repository's release content.
  // 将说明校验与仓库的发布内容隔离。
  const directory = mkdtempSync(join(tmpdir(), "uterm-notes-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = pathToFileURL(directory + "/");
  const notes = "## 中文\n\n修复会话重连。\n\n## English\n\nFix session reconnection.";
  writeFileSync(join(directory, "uTerm-v1.2.3.md"), notes);
  assert.equal(releaseNotes("uTerm-v1.2.3", root), notes);
  assert.equal(
    releaseNotes("uTerm-v1.2.4", root),
    "## 中文\n\nuTerm 1.2.4 发布。\n\n## English\n\nuTerm 1.2.4 release.",
  );
  writeFileSync(join(directory, "uTerm-v1.2.3.md"), "## 中文\n\n修复会话重连。");
  assert.throws(() => releaseNotes("uTerm-v1.2.3", root), /## English/);
  assert.throws(() => releaseNotes("../uTerm-v1.2.3", root), /Expected a stable/);
});
test("a feed requires every target, matching signatures, unchanged bytes, and a newer version", () => {
  const root = mkdtempSync(join(tmpdir(), "uterm-release-"));
  try {
    const output = join(root, "output");
    mkdirSync(output);
    assert.throws(() => manifest("uTerm-v1.2.3", output));
    for (const target of targets) {
      const bundle = join(root, target);
      mkdirSync(bundle);
      const path = join(bundle, "app-setup.exe");
      writeFileSync(path, `bundle for ${target}`);
      assert.throws(() => collect("uTerm-v1.2.3", target, bundle, output));
      writeFileSync(`${path}.sig`, Buffer.from("untrusted comment: signature").toString("base64"));
      assert.throws(() => collect("uTerm-v1.2.3", "linux-x86_64", bundle, output), /Unsupported/);

      collect("uTerm-v1.2.3", target, bundle, output);
    }
    const feed = manifest("uTerm-v1.2.3", output, { version: "1.2.2" });
    assert.deepEqual(Object.keys(feed.platforms), ["windows-x86_64"]);
    assert.equal(
      feed.platforms["windows-x86_64"].url,
      "https://github.com/test-owner/uterm/releases/download/uTerm-v1.2.3/uTerm-1.2.3-windows-x86_64-setup.exe",
    );
    for (const version of ["1.2.3", "1.2.4", "2.0.0"])
      assert.throws(() => manifest("uTerm-v1.2.3", output, { version }));
    const entry = JSON.parse(readFileSync(join(output, "windows-x86_64.json")));
    writeFileSync(join(output, entry.filename), "corrupt");
    assert.throws(() => manifest("uTerm-v1.2.3", output), /changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS artifacts and feeds remain separate from Windows and other architectures", () => {
  const root = mkdtempSync(join(tmpdir(), "uterm-mac-release-"));
  try {
    const output = join(root, "output");
    mkdirSync(output);
    for (const target of supportedTargets.filter((target) => target.startsWith("darwin"))) {
      const bundle = join(root, target);
      mkdirSync(bundle);
      writeFileSync(join(bundle, "uTerm.app.tar.gz"), `archive-${target}`);
      writeFileSync(
        join(bundle, "uTerm.app.tar.gz.sig"),
        Buffer.from("untrusted comment: test").toString("base64"),
      );
      assert.throws(() => collect("uTerm-v1.2.3", target, bundle, output), /DMG/);
      writeFileSync(join(bundle, "uTerm.dmg"), `installer-${target}`);
      collect("uTerm-v1.2.3", target, bundle, output);
      const feed = manifest("uTerm-v1.2.3", output, { version: "1.2.2" }, [target]);
      assert.deepEqual(Object.keys(feed.platforms), [target]);
      assert.match(
        feed.platforms[target].url,
        /uTerm-v1\.2\.3\/uTerm-1\.2\.3-darwin-.*\.app\.tar\.gz$/,
      );
      assert.equal(feedFilename(target), `latest-${target}.json`);
      writeFileSync(join(output, "latest.json"), "existing Windows feed");
      execFileSync(process.execPath, [
        fileURLToPath(new URL("../scripts/release.mjs", import.meta.url)),
        "manifest",
        "uTerm-v1.2.3",
        output,
        "-",
        target,
      ]);
      const written = JSON.parse(readFileSync(join(output, feedFilename(target)), "utf8"));
      assert.deepEqual(written.platforms, feed.platforms);
      assert.equal(readFileSync(join(output, "latest.json"), "utf8"), "existing Windows feed");
      assert.throws(
        () => manifest("uTerm-v1.2.3", output, { version: "1.2.3" }, [target]),
        /newer/,
      );
      assert.equal(
        readFileSync(join(output, `uTerm-1.2.3-${target}.dmg`), "utf8"),
        `installer-${target}`,
      );
    }
    assert.equal(feedFilename("windows-x86_64"), "latest.json");
    assert.throws(() => manifest("uTerm-v1.2.3", output));
    assert.throws(() => feedFilename("linux-x86_64"));
    assert.throws(() => manifest("uTerm-v1.2.3", output, undefined, []));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
