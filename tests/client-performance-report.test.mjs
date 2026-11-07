import test from "node:test";
import assert from "node:assert/strict";
import { verifyWorkload, percentile } from "../scripts/client-performance-report.mjs";

test("performance evidence rejects stale sources, incomplete output and numeric u64 sequences", () => {
  const fixture = {
    sessions: 1,
    cycles: 1,
    recordsPerCycle: 1024,
    columns: 120,
    rows: 36,
    tuiFrames: 1,
    slowConsumerMilliseconds: 200,
    maximumFrameBytes: 1048576,
    soakSeconds: 120,
    lastRepetitionSoakSeconds: 600,
  };
  const report = {
    fixture,
    fixtureSHA256: "hash",
    sessionCountMeasured: 1,
    viewport: { columns: 120, rows: 36 },
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
    tuiFrameMilliseconds: [1],
    databaseReadMilliseconds: [1],
    databasePerformanceMeasured: true,
    soakSecondsMeasured: 120,
    slowConsumer: {
      injectedDelayMilliseconds: 200,
      oneOutstandingFrame: true,
      orderedRecords: 1024,
      milliseconds: 201,
      largestFrameBytes: 1024,
      initialGateObserved: true,
      initialGateMilliseconds: 50,
    },
  };
  const verify = (value) => verifyWorkload(value, fixture, "hash", "head", "merge");
  verify(report);
  for (const changes of [
    { head: "old" },
    { tested: "old" },
    { fixtureSHA256: "different" },
    { productionDataAccess: true },
    { viewport: { columns: 119, rows: 36 } },
    { viewport: { columns: 120, rows: 35 } },
    { tuiFrameMilliseconds: [] },
    { databasePerformanceMeasured: false },
    { databaseReadMilliseconds: [] },
    { soakSecondsMeasured: 1 },
    { slowConsumer: { ...report.slowConsumer, oneOutstandingFrame: false } },
    { slowConsumer: { ...report.slowConsumer, initialGateObserved: false } },
    { slowConsumer: { ...report.slowConsumer, initialGateMilliseconds: 0 } },
    { slowConsumer: { ...report.slowConsumer, largestFrameBytes: 1048577 } },
    { cycles: [{ ...report.cycles[0], acknowledgedSequence: 18446744073709551615 }] },
    { cycles: [{ ...report.cycles[0], acknowledgedSequence: "18446744073709551616" }] },
    { cycles: [{ ...report.cycles[0], orderedRecords: 1023 }] },
    { cycles: [{ ...report.cycles[0], bulkMilliseconds: -1 }] },
  ])
    assert.throws(() => verify({ ...report, ...changes }));
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
});

test("idle trend rejects continued growth without confusing a one-time allocation with a leak", async () => {
  const { assessIdleGrowth } = await import("../scripts/client-performance-report.mjs");
  const mib = 1024 * 1024;
  const samples = (values) =>
    values.map((rss, index) => ({
      phase: "idle-soak",
      elapsedMilliseconds: index * 1000,
      processes: [{ rssBytes: rss * mib }],
    }));
  const thirds = (a, b, c) =>
    samples([...Array(20).fill(a), ...Array(20).fill(b), ...Array(20).fill(c)]);
  assert.equal(assessIdleGrowth(thirds(100, 100, 100)).sustainedGrowthDetected, false);
  assert.equal(assessIdleGrowth(thirds(100, 150, 150)).sustainedGrowthDetected, false);
  assert.equal(assessIdleGrowth(thirds(180, 150, 100)).sustainedGrowthDetected, false);
  assert.equal(assessIdleGrowth(thirds(100, 140, 180)).sustainedGrowthDetected, true);
  assert.throws(() => assessIdleGrowth(samples([100, 140])), /Too few idle/);
  const incomplete = thirds(100, 100, 100);
  incomplete[20].processes = [];
  assert.throws(() => assessIdleGrowth(incomplete));
  const nonmonotonic = thirds(100, 100, 100);
  nonmonotonic[20].elapsedMilliseconds = nonmonotonic[19].elapsedMilliseconds;
  assert.throws(() => assessIdleGrowth(nonmonotonic));
  const zeroDescendant = thirds(100, 100, 100);
  zeroDescendant[20].processes.push({ rssBytes: 0 });
  const observed = assessIdleGrowth(zeroDescendant);
  assert.equal(observed.sustainedGrowthDetected, false);
  assert.equal(observed.zeroRSSProcessRecords, 1);
  const allZero = thirds(100, 100, 100);
  allZero[20].processes = [{ rssBytes: 0 }];
  assert.throws(() => assessIdleGrowth(allZero), /no resident/);
});
