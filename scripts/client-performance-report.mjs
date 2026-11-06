import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { hostname, release, arch, cpus } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

export function verifyWorkload(report, fixture, fixtureSHA, head, tested) {
  assert.equal(report.fixtureSHA256, fixtureSHA, "Different workload bytes");
  assert.equal(report.sessionCountMeasured, fixture.sessions);
  assert.deepEqual(report.fixture, fixture);
  assert.equal(report.sourceHeadSHA ?? report.head, head, "Stale head");
  assert.equal(report.testedMergeSHA ?? report.tested ?? report.sourceSHA, tested, "Stale merge");
  assert(!report.failure && !report.sourceTreeDirty && report.productionDataAccess === false);
  assert.equal(report.cycles.length, fixture.cycles);
  assert.deepEqual(
    report.viewport,
    { columns: fixture.columns, rows: fixture.rows },
    "Actual client grid differs from the common workload",
  );
  for (const [index, sample] of report.cycles.entries()) {
    assert.equal(sample.cycle, index);
    assert.equal(sample.orderedRecords, fixture.recordsPerCycle);
    assert(
      Number.isFinite(sample.inputToParsedAckMilliseconds) &&
        sample.inputToParsedAckMilliseconds >= 0,
    );
    assert(Number.isFinite(sample.bulkMilliseconds) && sample.bulkMilliseconds >= 0);
    assert.equal(
      typeof sample.acknowledgedSequence,
      "string",
      "Sequence must retain u64 precision",
    );
    assert(
      BigInt(sample.acknowledgedSequence) > 0n &&
        BigInt(sample.acknowledgedSequence) <= 18446744073709551615n,
    );
  }
  assert.equal(report.fileSaveReadMilliseconds.length, fixture.cycles);
  assert(report.fileSaveReadMilliseconds.every((value) => Number.isFinite(value) && value >= 0));
  assert(Number.isFinite(report.replayMilliseconds) && report.replayMilliseconds >= 0);
  assert.equal(report.tuiFrameMilliseconds.length, fixture.tuiFrames);
  assert(report.tuiFrameMilliseconds.every((value) => Number.isFinite(value) && value >= 0));
  assert.equal(report.databaseReadMilliseconds.length, fixture.cycles);
  assert(report.databaseReadMilliseconds.every((value) => Number.isFinite(value) && value >= 0));
  assert.equal(report.databasePerformanceMeasured, true);
  assert.equal(report.slowConsumer.injectedDelayMilliseconds, fixture.slowConsumerMilliseconds);
  assert.equal(report.slowConsumer.oneOutstandingFrame, true);
  assert.equal(report.slowConsumer.initialGateObserved, true);
  assert(
    Number.isFinite(report.slowConsumer.initialGateMilliseconds) &&
      report.slowConsumer.initialGateMilliseconds >= 40,
  );
  assert.equal(report.slowConsumer.orderedRecords, fixture.recordsPerCycle);
  assert(
    Number.isFinite(report.slowConsumer.milliseconds) &&
      report.slowConsumer.milliseconds >= fixture.slowConsumerMilliseconds,
  );
  assert(
    report.slowConsumer.largestFrameBytes > 0 &&
      report.slowConsumer.largestFrameBytes <= fixture.maximumFrameBytes,
  );
  assert(
    [fixture.soakSeconds, fixture.lastRepetitionSoakSeconds].includes(report.soakSecondsMeasured),
  );
}

export function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  assert(sorted.length > 0);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] || "ci-evidence/performance");
  const fixtureBytes = readFileSync("shared/fixtures/client-performance.json");
  const fixture = JSON.parse(fixtureBytes);
  const fixtureSHA = createHash("sha256").update(fixtureBytes).digest("hex");
  const tested = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const head = process.env.PR_HEAD_SHA || tested;
  const summaries = [];
  const databaseService = JSON.parse(
    readFileSync(join(directory, "database-service/database-live.json"), "utf8"),
  );
  assert(
    databaseService.passed &&
      databaseService.readonlyFixtureUnchanged &&
      databaseService.noRemainingClientConnections &&
      databaseService.ownedServerStopped &&
      databaseService.credentialExcludedFromEvidence,
  );
  assert.equal(databaseService.sourceHeadSHA, head);
  assert.equal(databaseService.testedMergeSHA, tested);
  assert.equal(databaseService.sourceTreeDirty, false);
  for (let repetition = 1; repetition <= 3; repetition++) {
    for (const client of process.platform === "darwin" ? ["native", "tauri"] : ["tauri"]) {
      const base = join(directory, `${client}-${repetition}`);
      const envelope = JSON.parse(
        readFileSync(
          join(base, client === "native" ? "native-performance.json" : "report.json"),
          "utf8",
        ),
      );
      assert(envelope.passed && !envelope.cleanupErrors?.length);
      const report =
        client === "native"
          ? envelope
          : {
              ...envelope.scenes.find((scene) => scene.scenario === "performance-complete").checks,
              ...Object.fromEntries(
                Object.entries(envelope).filter(([key]) =>
                  ["head", "tested", "sourceTreeDirty", "productionDataAccess"].includes(key),
                ),
              ),
            };
      verifyWorkload(report, fixture, fixtureSHA, head, tested);
      const soak = repetition === 3 ? fixture.lastRepetitionSoakSeconds : fixture.soakSeconds;
      assert.equal(report.soakSecondsMeasured, soak);
      const resources = JSON.parse(readFileSync(join(base, `resources-${client}.json`), "utf8"));
      assert(!resources.errors.length && resources.sampleCount >= 10);
      const idle = resources.samples.filter((sample) => sample.phase === "idle-soak");
      assert(
        idle.length > 10 &&
          idle.at(-1).elapsedMilliseconds - idle[0].elapsedMilliseconds >= (soak - 2) * 1000,
        "Missing real idle soak",
      );
      const steady = report.cycles.slice(fixture.warmupCycles);
      const images =
        client === "native" ? report.captures : envelope.scenes.map((scene) => scene.screenshot);
      for (const image of images)
        assert(existsSync(join(base, image)), "Missing actual window capture");
      summaries.push({
        client,
        repetition,
        viewport: report.viewport,
        fixtureSHA256: fixtureSHA,
        inputMedianMilliseconds: percentile(
          steady.map((sample) => sample.inputToParsedAckMilliseconds),
          0.5,
        ),
        inputP95Milliseconds: percentile(
          steady.map((sample) => sample.inputToParsedAckMilliseconds),
          0.95,
        ),
        bulkMedianMilliseconds: percentile(
          steady.map((sample) => sample.bulkMilliseconds),
          0.5,
        ),
        fileMedianMilliseconds: percentile(
          report.fileSaveReadMilliseconds.slice(fixture.warmupCycles),
          0.5,
        ),
        replayMilliseconds: report.replayMilliseconds,
        tuiMedianMilliseconds: percentile(
          report.tuiFrameMilliseconds.slice(fixture.warmupCycles),
          0.5,
        ),
        tuiP95Milliseconds: percentile(
          report.tuiFrameMilliseconds.slice(fixture.warmupCycles),
          0.95,
        ),
        databaseMedianMilliseconds: percentile(
          report.databaseReadMilliseconds.slice(fixture.warmupCycles),
          0.5,
        ),
        databaseP95Milliseconds: percentile(
          report.databaseReadMilliseconds.slice(fixture.warmupCycles),
          0.95,
        ),
        slowConsumer: report.slowConsumer,
        idleMeasurementSeconds: soak,
        idleFirstRSSBytes: resources.phases["idle-soak"].firstRSSBytes,
        idleLastRSSBytes: resources.phases["idle-soak"].lastRSSBytes,
        idleRSSChangeBytes:
          resources.phases["idle-soak"].lastRSSBytes - resources.phases["idle-soak"].firstRSSBytes,
        resources: resources.phases,
        captures: images,
      });
    }
  }
  const viewports = summaries.map((value) => JSON.stringify(value.viewport));
  const result = {
    passed: true,
    sourceHeadSHA: head,
    testedMergeSHA: tested,
    fixtureSHA256: fixtureSHA,
    machine: {
      hostname: hostname(),
      architecture: arch(),
      system: release(),
      cpu: cpus()[0]?.model,
      logicalCPUs: cpus().length,
    },
    summaries,
    databaseService,
    sameMachineSequentialClients: process.platform === "darwin",
    equalViewport: new Set(viewports).size === 1,
    measurementLimits: [
      "Scripted actual client input to parsed/acknowledged output; not physical keyboard/display latency",
      "CPU/RSS cover owned PID trees; unattributed WebContent/GPU/XPC excluded",
      "Three sequential repetitions on a shared CI runner; startup warm-up cycles excluded",
      "First two repetitions idle for 120 seconds, final repetition for 600; this does not establish multi-hour leak acceptance",
      "Synthetic deterministic alternate-screen redraw through real PTYs; not an interactive Vim benchmark",
      "Actual Core/JDBC queries include row serialization, not database table painting or the external PostgreSQL server CPU/RSS",
      "Screenshot capture uses a separate phase, outside output/database/idle metrics",
      "Unequal viewport grids block direct rendering-speed conclusions",
    ],
    improvementClaim: false,
    performanceAcceptanceComplete: false,
    productionDataAccess: false,
  };
  writeFileSync(join(directory, "comparison.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
