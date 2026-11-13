import test from "node:test";
import assert from "node:assert/strict";
import { writeFavoriteFixture } from "../src/qa/git-favorite-fixture.ts";

const baseline = {
  repository: "qa-repository",
  revision: "before",
  sourceDigest: "source",
  references: ["refs/heads/main"],
};
const busy = () => Object.assign(Error("Owned writer lock"), { code: "WRITER_BUSY" });

test("favorite fixture explicitly retries a busy write only while its full snapshot is unchanged", async () => {
  let writes = 0,
    reads = 0;
  const attempts = [];
  const saved = { ...baseline, revision: "after", references: [] };
  assert.equal(
    await writeFavoriteFixture(
      baseline,
      async () => {
        if (++writes === 1) throw busy();
        return saved;
      },
      async () => {
        reads++;
        return structuredClone(baseline);
      },
      (value) => attempts.push(value),
      async () => {},
    ),
    saved,
  );
  assert.equal(writes, 2);
  assert.equal(reads, 1);
  assert.deepEqual(
    attempts.map((item) => [item.saved, item.unchangedOnBusy]),
    [
      [false, true],
      [true, true],
    ],
  );
});

test("a partial or competing favorite change prevents replay of the failed fixture write", async () => {
  for (const changed of [
    { ...baseline, revision: "committed" },
    { ...baseline, repository: "other" },
    { ...baseline, sourceDigest: "changed" },
    { ...baseline, references: [] },
  ]) {
    let writes = 0;
    const failure = busy();
    await assert.rejects(
      writeFavoriteFixture(
        baseline,
        async () => {
          writes++;
          throw failure;
        },
        async () => changed,
        () => {},
        async () => {},
      ),
      (reason) => reason === failure,
    );
    assert.equal(writes, 1);
  }
});

test("favorite conflicts are returned without a retry or a follow-up read", async () => {
  let writes = 0,
    reads = 0;
  const conflict = Object.assign(Error("Changed revision"), { code: "CONFLICT" });
  await assert.rejects(
    writeFavoriteFixture(
      baseline,
      async () => {
        writes++;
        throw conflict;
      },
      async () => {
        reads++;
        return baseline;
      },
      () => {},
      async () => {},
    ),
    (reason) => reason === conflict,
  );
  assert.equal(writes, 1);
  assert.equal(reads, 0);
});

test("favorite fixture stops after three busy attempts and propagates read failures", async () => {
  let writes = 0;
  await assert.rejects(
    writeFavoriteFixture(
      baseline,
      async () => {
        writes++;
        throw busy();
      },
      async () => baseline,
      () => {},
      async () => {},
    ),
    { code: "WRITER_BUSY" },
  );
  assert.equal(writes, 3);
  const readFailure = Error("Could not verify the saved favorites");
  writes = 0;
  await assert.rejects(
    writeFavoriteFixture(
      baseline,
      async () => {
        writes++;
        throw busy();
      },
      async () => {
        throw readFailure;
      },
      () => {},
      async () => {},
    ),
    (reason) => reason === readFailure,
  );
  assert.equal(writes, 1);
});
