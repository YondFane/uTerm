import test from "node:test";
import assert from "node:assert/strict";
import { gitFilePath, gitReadError, sameGitSnapshot } from "../src/lib/git-snapshot.ts";

test("Git reads treat plain directories as empty and retain unrelated failures", () => {
  assert.equal(
    gitReadError("fatal: not a git repository (or any of the parent directories): .git"),
    "",
  );
  assert.equal(gitReadError(new Error("fatal: not a git repository: '/plain'")), "");
  for (const message of [
    "fatal: detected dubious ownership",
    "fatal: bad object HEAD",
    "Permission denied",
    "git executable not found",
    "fatal: repository unavailable",
  ])
    assert.equal(gitReadError(message), message);
});

test("Git file paths stay relative to the selected root, including Windows subdirectories", () => {
  assert.equal(gitFilePath("/repo", "/repo", "中文 file.txt"), "中文 file.txt");
  assert.equal(gitFilePath("/repo/src", "/repo", "src/file.txt"), "file.txt");
  assert.equal(gitFilePath("/repo/src", "/repo", "src-other/file.txt"), null);
  assert.equal(gitFilePath("/repo/src", "/repo", "README.md"), null);
  assert.equal(gitFilePath("/repo", "/repo", "../outside.txt"), null);
  assert.equal(gitFilePath("/repo", "/repo", "src/../../outside.txt"), null);
  assert.equal(gitFilePath("/repo", "/Repo", "file.txt"), null);
  assert.equal(
    gitFilePath("\\\\?\\C:\\Repo\\src\\", "c:/repo", "src/中文 file.txt"),
    "中文 file.txt",
  );
  assert.equal(
    gitFilePath("\\\\?\\UNC\\server\\share\\repo\\src", "//server/share/repo", "src/file.txt"),
    "file.txt",
  );
});

const snapshot = {
  root: "/project",
  branch: "main",
  references: ["main", "origin/main"],
  changes: [{ path: "file.txt", original: null, index: " ", working: "M" }],
  truncated: false,
};

test("Git snapshots compare without serializing unchanged file lists", () => {
  assert.equal(sameGitSnapshot(snapshot, structuredClone(snapshot)), true);
  assert.equal(
    sameGitSnapshot(snapshot, { ...snapshot, changes: [{ ...snapshot.changes[0], working: " " }] }),
    false,
  );
  assert.equal(sameGitSnapshot(snapshot, { ...snapshot, references: ["main"] }), false);
  assert.equal(sameGitSnapshot(snapshot, { ...snapshot, head: "a".repeat(40) }), false);
});
