import assert from "node:assert/strict";

export function assertParityScenes(actual, fixture) {
  const expected = [];
  for (const language of fixture.languages)
    for (const appearance of fixture.appearances)
      for (const width of fixture.widths)
        expected.push(`workspace-${language}-${appearance}-${width}`);
  for (const scene of fixture.settingsScenes)
    for (const section of fixture.settingsSections)
      expected.push(`settings-${section.id}-${scene.language}-${scene.appearance}-${scene.width}`);
  for (const scene of fixture.contentScenes)
    expected.push(`pdf-highlights-${scene.language}-${scene.appearance}-${scene.width}`);
  expected.push(...fixture.ordinaryOperations);
  assert.deepEqual([...actual].sort(), expected.sort(), "Incomplete ordinary-client parity grid");
}

export function assertParityOperations(scenes, fixture) {
  const restarts = scenes.filter((scene) => scene.scenario === "terminal-restart");
  assert.equal(restarts.length, 1, "Missing or duplicate ordinary restart evidence");
  const checks = restarts[0].checks;
  for (const key of [
    "passed",
    "actualRestartButton",
    "parsedUnicodeOutput",
    "canonicalWorkspaceRetained",
    "terminalViewRetained",
  ])
    assert.equal(checks[key], true, `Unaccepted ordinary restart: ${key}`);
  assert.ok(typeof checks.generationBeforeRestart === "string" && checks.generationBeforeRestart);
  assert.ok(typeof checks.restartedGeneration === "string" && checks.restartedGeneration);
  assert.notEqual(checks.generationBeforeRestart, checks.restartedGeneration);
  const pdf = scenes.filter((scene) => scene.scenario.startsWith("pdf-highlights-"));
  assert.equal(pdf.length, fixture.contentScenes.length, "Missing or duplicate PDF evidence");
  const seen = new Set();
  for (const scene of pdf) {
    const checks = scene.checks;
    const identity = `pdf-highlights-${checks.language}-${checks.appearance}-${checks.width}`;
    assert.equal(scene.scenario, identity);
    assert.ok(!seen.has(identity), "Duplicate PDF evidence");
    seen.add(identity);
    assert.ok(
      fixture.contentScenes.some(
        (expected) =>
          expected.language === checks.language &&
          expected.appearance === checks.appearance &&
          expected.width === checks.width &&
          expected.height === checks.height,
      ),
      "Unexpected PDF scene",
    );
    assert.equal(checks.pdfSHA256, fixture.pdf.sha256);
    assert.equal(checks.markID, fixture.pdf.mark.id);
    assert.equal(checks.marksCount, 1);
    for (const key of [
      "passed",
      "actualRemoveButton",
      "reopenedRestoredMarks",
      "originalPdfUnchanged",
      "inMainWorkspace",
      "settingsPreserveDocument",
    ])
      assert.equal(checks[key], true, `Unaccepted ordinary PDF: ${key}`);
  }
}
