import test from "node:test";
import assert from "node:assert/strict";
import { formatCommitTimestamp, HistoryPager } from "../src/lib/git-history.ts";

const page = (start) => Array.from({ length: 100 }, (_, index) => ({ id: String(start + index) }));
const deferred = () => Promise.withResolvers();

test("commit timestamps include hours, minutes, and seconds", () => {
  const timestamp = new Date(2026, 8, 25, 1, 2, 3).toISOString();

  assert.match(formatCommitTimestamp(timestamp, "en-CA"), /01:02:03/);
});

test("refresh invalidates an older pagination response and its loading state", async () => {
  const pager = new HistoryPager();
  const changes = [];
  const publish = (state) => changes.push(state);
  await pager.load(async () => page(0), publish, true);
  const old = deferred();
  const pending = pager.load(() => old.promise, publish);
  const refreshed = deferred();
  const refreshing = pager.load(() => refreshed.promise, publish, true);
  old.resolve(page(100));
  await pending;
  assert.equal(pager.state.loading, true);
  assert.deepEqual(pager.state.items, []);
  refreshed.resolve([{ id: "new-head" }]);
  await refreshing;
  assert.deepEqual(pager.state.items, [{ id: "new-head" }]);
  assert.equal(pager.state.loading, false);
  assert.equal(pager.state.more, false);
  assert.equal(changes.at(-1), pager.state);
});

test("pagination rejects duplicate clicks, deduplicates shifted pages, and keeps the raw offset", async () => {
  const pager = new HistoryPager();
  const publish = () => {};
  await pager.load(async () => page(0), publish, true);
  const next = deferred();
  const pending = pager.load((skip) => {
    assert.equal(skip, 100);
    return next.promise;
  }, publish);
  await pager.load(() => {
    assert.fail("duplicate request");
  }, publish);
  next.resolve(page(99));
  await pending;
  assert.equal(pager.state.items.length, 199);
  await pager.load(async (skip) => {
    assert.equal(skip, 200);
    return [];
  }, publish);
  assert.equal(pager.state.more, false);
});

test("failed pages can retry and responses after leaving history cannot publish", async () => {
  const pager = new HistoryPager();
  const changes = [];
  const publish = (state) => changes.push(state);
  await pager.load(
    async () => {
      throw new Error("offline");
    },
    publish,
    true,
  );
  assert.match(pager.state.error, /offline/);
  await pager.load(async (skip) => {
    assert.equal(skip, 0);
    return page(0);
  }, publish);
  assert.equal(pager.state.error, "");
  const stale = deferred();
  const pending = pager.load(() => stale.promise, publish);
  pager.invalidate();
  const count = changes.length;
  stale.reject(new Error("late failure"));
  await pending;
  assert.equal(changes.length, count);
  assert.equal(pager.state.error, "");
});
