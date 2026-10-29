import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeRemoteReferences,
  referenceTree,
  visibleReferenceNodes,
  referenceView,
  rememberReferenceView,
} from "../src/lib/git-references.ts";

const ref = (kind, name, extra = {}) => ({
  kind,
  name,
  full_name:
    kind === "head"
      ? "HEAD"
      : `refs/${kind === "local" ? "heads" : kind === "remote" ? "remotes" : "tags"}/${name}`,
  oid: "a".repeat(40),
  current: false,
  upstream: null,
  ahead: null,
  behind: null,
  worktree: null,
  remote: null,
  branch: null,
  ...extra,
});
test("reference hierarchy preserves full identities across remotes and nested bilingual names", () => {
  const references = [
    ref("head", "HEAD"),
    ref("local", "feature/中文/deep"),
    ref("local", "main"),
    ref("remote", "origin/feature/中文", { remote: "origin", branch: "feature/中文" }),
    ref("remote", "upstream/feature/中文", { remote: "upstream", branch: "feature/中文" }),
    ref("tag", "release/v1"),
  ];
  const rows = visibleReferenceNodes(referenceTree(references, new Set()), new Set(), false);
  assert.equal(rows.find((row) => row.id === "refs/heads/feature/中文/deep").level, 4);
  assert.equal(rows.filter((row) => row.reference?.kind === "remote").length, 2);
  assert.equal(rows.find((row) => row.id === "remote/origin").remote, "origin");
  assert.equal(rows.filter((row) => row.reference).length, references.length);
});
test("search matches full names and expands matches without changing saved collapse state", () => {
  const refs = [ref("local", "feature/中文/deep"), ref("local", "main")];
  const collapsed = new Set(["local", "local/feature"]);
  assert.equal(visibleReferenceNodes(referenceTree(refs, new Set()), collapsed, false).length, 3);
  const matches = visibleReferenceNodes(
    referenceTree(refs, new Set(), "FEATURE/中文"),
    collapsed,
    true,
  );
  assert.equal(matches.at(-1).id, "refs/heads/feature/中文/deep");
  assert.deepEqual([...collapsed], ["local", "local/feature"]);
  assert.equal(
    visibleReferenceNodes(referenceTree(refs, new Set(), "missing"), collapsed, true).length,
    0,
  );
});
test("favorites sort among siblings and advertised references never pretend to be fetched", () => {
  const refs = [
    ref("local", "alpha"),
    ref("local", "zeta"),
    ref("remote", "origin/main", { remote: "origin", branch: "main" }),
  ];
  const merged = mergeRemoteReferences(refs, [
    { remote: "origin", branch: "main" },
    { remote: "origin", branch: "new" },
    { remote: "upstream", branch: "new" },
  ]);
  assert.equal(merged.length, 5);
  assert.equal(merged.find((item) => item.name === "origin/main").oid, "a".repeat(40));
  assert.equal(merged.find((item) => item.name === "origin/new").oid, null);
  assert.equal(
    referenceTree(merged, new Set(["refs/heads/zeta"]))[0].children[0].id,
    "refs/heads/zeta",
  );
});
test("reference view state is retained per directory during this run", () => {
  const state = { selected: "refs/tags/v1", search: "v1", collapsed: ["remote"], folded: true };
  rememberReferenceView("/repo/state", state);
  assert.deepEqual(referenceView("/repo/state"), state);
  assert.equal(referenceView("/other/state").selected, "HEAD");
});
