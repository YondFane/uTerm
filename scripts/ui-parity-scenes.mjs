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
  for (const scene of fixture.quickScenes)
    expected.push(`quick-ssh-invalid-${scene.language}-${scene.appearance}-${scene.width}`);
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
    assert.equal(checks.fixtureSessionCount, 1);
    assert.equal(checks.filesFolderExpanded, true);
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
  const quick = scenes.filter((scene) => scene.scenario.startsWith("quick-ssh-invalid-"));
  assert.equal(quick.length, fixture.quickScenes.length, "Missing or duplicate Quick SSH evidence");
  const quickSeen = new Set();
  for (const scene of quick) {
    const checks = scene.checks;
    const identity = `quick-ssh-invalid-${checks.language}-${checks.appearance}-${checks.width}`;
    assert.equal(scene.scenario, identity);
    assert.ok(!quickSeen.has(identity), "Duplicate Quick SSH evidence");
    quickSeen.add(identity);
    assert.ok(
      fixture.quickScenes.some(
        (expected) =>
          expected.language === checks.language &&
          expected.appearance === checks.appearance &&
          expected.width === checks.width &&
          expected.height === checks.height,
      ),
      "Unexpected Quick SSH scene",
    );
    assert.equal(checks.inputAddress, fixture.quickAddress);
    assert.equal(checks.terminalFixtureMarker, fixture.marker);
    for (const key of [
      "passed",
      "invalidInputRejected",
      "addressRetained",
      "savedWorkspaceUnchanged",
      "sameMainWindow",
      "terminalGenerationRetained",
      "actualSidebarButton",
      "actualCancelPreservedState",
      "workspaceVisibleAroundDialog",
    ])
      assert.equal(checks[key], true, `Unaccepted ordinary Quick SSH: ${key}`);
    for (const key of ["modalLeft", "modalTop", "modalWidth", "modalHeight"])
      assert.ok(Number.isFinite(checks[key]), `Missing actual Quick SSH geometry: ${key}`);
    assert.ok(
      Math.abs(checks.modalWidth - Math.min(540, checks.width - 32)) < 1,
      "Quick SSH covers more than its form",
    );
    assert.ok(
      checks.modalHeight >= 40 && checks.modalHeight <= checks.height - 48,
      "Quick SSH form is clipped",
    );
    assert.ok(
      Math.abs(checks.modalLeft - (checks.width - checks.modalWidth) / 2) < 1 &&
        Math.abs(checks.modalTop - (checks.height - checks.modalHeight) / 2) < 1,
      "Quick SSH form is not centered",
    );
  }
}
