import test from "node:test";
import assert from "node:assert/strict";
import { verifyWorkload, percentile } from "../scripts/client-performance-report.mjs";

test("performance evidence rejects stale sources, incomplete output and numeric u64 sequences", () => {
  const fixture = { sessions: 1, cycles: 1, recordsPerCycle: 1024 };
  const report = {
    fixture,
    fixtureSHA256: "hash",
    sessionCountMeasured: 1,
    head: "head",
    tested: "merge",
    productionDataAccess: false,
    cycles: [
      {
        cycle: 0,
        orderedRecords: 1024,
        inputToParsedAckMilliseconds: 1,
        bulkMilliseconds: 2,
        acknowledgedSequence: "18446744073709551615",
      },
    ],
    fileSaveReadMilliseconds: [1],
    replayMilliseconds: 2,
  };
  const verify = (value) => verifyWorkload(value, fixture, "hash", "head", "merge");
  verify(report);
  for (const changes of [
    { head: "old" },
    { tested: "old" },
    { fixtureSHA256: "different" },
    { productionDataAccess: true },
    { cycles: [{ ...report.cycles[0], acknowledgedSequence: 18446744073709551615 }] },
    { cycles: [{ ...report.cycles[0], orderedRecords: 1023 }] },
    { cycles: [{ ...report.cycles[0], bulkMilliseconds: -1 }] },
  ])
    assert.throws(() => verify({ ...report, ...changes }));
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
});
