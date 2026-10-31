import test from "node:test";
import assert from "node:assert/strict";
import { gitFileKey, gitFileStates } from "../src/lib/git-file-status.ts";

const change = (path, index = " ", working = "M", original = null) => ({
  path,
  index,
  working,
  original,
});
const snapshot = (root, changes, truncated = false) => ({ root, changes, truncated });
const sorted = (states) => [...states].sort(([left], [right]) => left.localeCompare(right));

test("Git tree states classify both columns and mark changed ancestors", () => {
  const states = gitFileStates(
    "/repo",
    snapshot("/repo", [
      change("src/staged.ts", "M", " "),
      change("src/working.ts"),
      change("src/new-edited.ts", "A", "M"),
      change("type.ts", " ", "T"),
      change("added.ts", "A", " "),
      change("removed.ts", " ", "D"),
      change("new/deep/中文 & %PATH%.ts", "?", "?"),
      change("clean.ts", " ", " "),
    ]),
  );
  assert.equal(states.get("src/staged.ts"), "modified");
  assert.equal(states.get("src/working.ts"), "modified");
  assert.equal(states.get("src/new-edited.ts"), "modified");
  assert.equal(states.get("src"), "modified");
  assert.equal(states.get("type.ts"), "modified");
  assert.equal(states.get("added.ts"), "added");
  assert.equal(states.get("removed.ts"), "deleted");
  for (const path of ["new", "new/deep", "new/deep/中文 & %PATH%.ts"])
    assert.equal(states.get(path), "untracked");
  assert.equal(states.has("clean.ts"), false);
  assert.equal(states.has(""), false);
});

test("Git tree states stay within the selected subdirectory and reject traversal", () => {
  const states = gitFileStates(
    "/repo/src",
    snapshot("/repo", [
      change("src/nested/file.ts"),
      change("src-other/file.ts"),
      change("README.md"),
      change("src/../outside.ts"),
      change("src/nested/../../outside.ts"),
    ]),
  );
  assert.deepEqual(sorted(states), [
    ["nested", "modified"],
    ["nested/file.ts", "modified"],
  ]);
  assert.equal(gitFileStates("/elsewhere", snapshot("/repo", [change("file.ts")])).size, 0);
  assert.equal(gitFileStates("/repo", null).size, 0);
  assert.equal(gitFileStates("/repo", snapshot("/repo", [])).size, 0);
});

test("Renames decorate both parent paths without mislabeling a recreated source file", () => {
  const changes = [
    change("new/nested/name.ts", "R", " ", "old/nested/name.ts"),
    change("old/nested/name.ts", "?", "?"),
  ];
  const states = gitFileStates("/repo", snapshot("/repo", changes));
  for (const path of ["new", "new/nested", "new/nested/name.ts"])
    assert.equal(states.get(path), "renamed");
  for (const path of ["old", "old/nested"]) assert.equal(states.get(path), "deleted");
  assert.equal(states.get("old/nested/name.ts"), "untracked");
  assert.deepEqual(
    sorted(states),
    sorted(gitFileStates("/repo", snapshot("/repo", [...changes].reverse()))),
  );

  const oldRoot = gitFileStates("/repo/old", snapshot("/repo", changes.slice(0, 1)));
  assert.deepEqual(sorted(oldRoot), [["nested", "deleted"]]);
  const newRoot = gitFileStates("/repo/new", snapshot("/repo", changes.slice(0, 1)));
  assert.deepEqual(sorted(newRoot), [
    ["nested", "renamed"],
    ["nested/name.ts", "renamed"],
  ]);
});

test("Copy targets count as added while unchanged copy sources remain undecorated", () => {
  const states = gitFileStates(
    "/repo",
    snapshot("/repo", [change("copies/file.ts", "C", " ", "source/file.ts")]),
  );
  assert.equal(states.get("copies"), "added");
  assert.equal(states.get("copies/file.ts"), "added");
  assert.equal(states.has("source"), false);
  assert.equal(states.has("source/file.ts"), false);
});

test("Untracked embedded repositories decorate directory placeholders and their ancestors", () => {
  const data = snapshot("/repo", [change("vendor/nested/", "?", "?")]);
  assert.deepEqual(sorted(gitFileStates("/repo", data)), [
    ["vendor", "untracked"],
    ["vendor/nested", "untracked"],
  ]);
  assert.deepEqual([...gitFileStates("/repo/vendor", data)], [["nested", "untracked"]]);
  for (const path of ["../", "/", "vendor//"])
    assert.equal(gitFileStates("/repo", snapshot("/repo", [change(path, "?", "?")])).size, 0);
});

test("All porcelain conflict combinations propagate conflict state to their parents", () => {
  for (const pair of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
    const states = gitFileStates(
      "/repo",
      snapshot("/repo", [change(`conflicts/${pair}.ts`, pair[0], pair[1])]),
    );
    assert.equal(states.get(`conflicts/${pair}.ts`), "conflict", pair);
    assert.equal(states.get("conflicts"), "conflict", pair);
  }
});

test("Mixed states have a fixed priority independent of Git result order", () => {
  const codes = {
    conflict: ["A", "A"],
    modified: [" ", "M"],
    renamed: ["R", " "],
    deleted: ["D", " "],
    added: ["A", " "],
    untracked: ["?", "?"],
  };
  const order = ["conflict", "modified", "renamed", "deleted", "added", "untracked"];
  for (let index = 0; index < order.length - 1; index++) {
    const higher = order[index];
    const lower = order[index + 1];
    const changes = [
      change("mixed/higher.ts", ...codes[higher]),
      change("mixed/lower.ts", ...codes[lower]),
    ];
    const forward = gitFileStates("/repo", snapshot("/repo", changes));
    const reversed = gitFileStates("/repo", snapshot("/repo", [...changes].reverse()));
    assert.equal(forward.get("mixed"), higher);
    assert.deepEqual(sorted(forward), sorted(reversed));
  }
});

test("Windows and UNC keys ignore case and support selected repository subdirectories", () => {
  assert.equal(gitFileKey("C:\\Repo", "Folder\\FILE.ts"), "folder/file.ts");
  assert.equal(gitFileKey("\\\\?\\C:\\Repo", "Folder/FILE.ts"), "folder/file.ts");
  const windows = gitFileStates(
    "\\\\?\\C:\\Repo\\SRC\\",
    snapshot("c:/repo", [change("src/Folder/FILE.ts")]),
  );
  assert.equal(windows.get("folder/file.ts"), "modified");
  assert.equal(windows.get("folder"), "modified");
  const unc = gitFileStates(
    "\\\\?\\UNC\\Server\\Share\\Repo\\Sub\\",
    snapshot("//server/share/repo", [change("SUB/Folder/FILE.ts")]),
  );
  assert.equal(unc.get("folder/file.ts"), "modified");
  assert.equal(gitFileKey("//server/share/repo", "Folder/FILE.ts"), "folder/file.ts");
});

test("POSIX keys retain case and literal backslashes in names and selected roots", () => {
  assert.equal(gitFileKey("/repo", "Folder\\FILE.ts"), "Folder\\FILE.ts");
  const states = gitFileStates(
    "/repo",
    snapshot("/repo", [change("A.ts"), change("a.ts", "A", " "), change("folder/odd\\name.ts")]),
  );
  assert.equal(states.get("A.ts"), "modified");
  assert.equal(states.get("a.ts"), "added");
  assert.equal(states.get("folder/odd\\name.ts"), "modified");
  assert.equal(states.has("folder/odd"), false);
  const selected = gitFileStates(
    "/repo/folder\\name",
    snapshot("/repo", [change("folder\\name/child.ts")]),
  );
  assert.deepEqual([...selected], [["child.ts", "modified"]]);
  assert.equal(gitFileStates("/Repo", snapshot("/repo", [change("file.ts")])).size, 0);
});

test("A truncated snapshot still decorates its known paths without mutating the snapshot", () => {
  const data = snapshot("/repo", [change("known/file.ts")], true);
  const before = structuredClone(data);
  const states = gitFileStates("/repo", data);
  assert.equal(states.get("known"), "modified");
  assert.deepEqual(data, before);
});
