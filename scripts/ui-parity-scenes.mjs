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
  for (const scene of fixture.githubScenes)
    expected.push(`github-pr-draft-${scene.language}-${scene.appearance}-${scene.width}`);
  for (const item of fixture.runPanelScenes)
    for (const kind of fixture.runPanelKinds)
      for (const state of fixture.runPanelStates)
        expected.push(`run-${kind}-${state}-${item.language}-${item.appearance}-${item.width}`);
  for (const item of fixture.runPanelScenes)
    for (const kind of fixture.runPanelKinds)
      expected.push(`run-form-${kind}-${item.language}-${item.appearance}-${item.width}`);
  expected.push(...fixture.ordinaryOperations);
  assert.deepEqual([...actual].sort(), expected.sort(), "Incomplete ordinary-client parity grid");
}

export function assertParityOperations(scenes, fixture) {
  const runs = scenes.filter(
    (scene) =>
      scene.scenario.startsWith("run-") &&
      !scene.scenario.startsWith("run-form-") &&
      scene.scenario !== "run-panels-complete",
  );
  assert.equal(
    runs.length,
    fixture.runPanelScenes.length * fixture.runPanelKinds.length * fixture.runPanelStates.length,
    "Incomplete run-panel operation grid",
  );
  const seenRuns = new Set();
  for (const { scenario, checks } of runs) {
    const key = `run-${checks.kind}-${checks.state}-${checks.language}-${checks.appearance}-${checks.width}`;
    assert.equal(scenario, key, "Substituted run-panel identity");
    assert.ok(!seenRuns.has(key), "Duplicate run-panel operation");
    seenRuns.add(key);
    assert.ok(
      fixture.runPanelKinds.includes(checks.kind) && fixture.runPanelStates.includes(checks.state),
    );
    assert.ok(
      fixture.runPanelScenes.some((item) =>
        ["language", "appearance", "width", "height"].every(
          (field) => checks[field] === item[field],
        ),
      ),
    );
    for (const field of ["panelLeft", "panelTop", "panelWidth", "panelHeight", "panelHeaderHeight"])
      assert.ok(
        Number.isFinite(checks[field]) && checks[field] >= 0,
        "Invalid actual run-panel geometry: " + field,
      );
    assert.ok(checks.panelHeaderHeight > 0 && checks.panelHeaderHeight <= checks.panelHeight);
    assert.ok(
      checks.panelWidth > 0 &&
        checks.panelHeight > 0 &&
        checks.panelLeft + checks.panelWidth <= checks.width + 0.5 &&
        checks.panelTop + checks.panelHeight <= checks.height + 0.5,
    );

    for (const key of [
      "passed",
      "actualToolbarButton",
      "actualExpandAndRestore",
      "retainedPanelView",
      "terminalGenerationRetained",
      "canonicalWorkspaceRetained",
    ])
      assert.equal(checks[key], true, `Unverified run-panel control: ${key}`);
    assert.equal(checks.fileVisible, checks.state === "file");
  }
  const forms = scenes.filter((row) => row.scenario.startsWith("run-form-"));
  const expectedForms = fixture.runPanelScenes.flatMap((scene) =>
    fixture.runPanelKinds.map(
      (kind) => `run-form-${kind}-${scene.language}-${scene.appearance}-${scene.width}`,
    ),
  );
  assert.deepEqual(
    forms.map((row) => row.scenario).sort(),
    expectedForms.sort(),
    "Missing or duplicate actual run-form scenes",
  );
  for (const { scenario, checks } of forms) {
    assert.equal(
      scenario,
      `run-form-${checks.kind}-${checks.language}-${checks.appearance}-${checks.width}`,
    );
    assert.ok(
      fixture.runPanelScenes.some((scene) =>
        ["language", "appearance", "width", "height"].every((key) => scene[key] === checks[key]),
      ),
    );
    for (const key of [
      "passed",
      "actualAdvancedToggle",
      "actualTextEditorInput",
      "invalidArgumentRetainedWithoutWrite",
      "literalArgumentsSaved",
      "validArgumentTextRetained",
      "temporaryEnvironmentRetainedWithoutPersistence",
      "actualSaveButtonAndFeedback",
      "compactRightAlignedSave",
      "canonicalStateAndSessionRetained",
    ])
      assert.equal(checks[key], true, "Unverified actual run-form action: " + key);
    assert.equal(checks.fixtureArguments, fixture.runFormInput.arguments);
    assert.equal(checks.fixtureEnvironment, fixture.runFormInput.environment);
    assert.deepEqual(checks.savedArguments, fixture.runFormInput.argumentValues);
    for (const key of ["saveWidth", "saveHeight", "saveRightInset"])
      assert.ok(Number.isFinite(checks[key]));
    assert.ok(
      checks.saveWidth > 0 &&
        checks.saveWidth < 200 &&
        checks.saveHeight > 0 &&
        checks.saveHeight <= 30 &&
        checks.saveRightInset >= 0 &&
        checks.saveRightInset <= 40,
    );
  }
  const runCleanup = scenes.filter((scene) => scene.scenario === "run-panels-complete");
  assert.equal(runCleanup.length, 1, "Missing run-panel cleanup proof");
  for (const key of [
    "passed",
    "actualFileCloseAndHideVerified",
    "terminalGenerationRetained",
    "canonicalWorkspaceRetained",
  ])
    assert.equal(runCleanup[0].checks[key], true, `Unverified run-panel cleanup: ${key}`);

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
  const prs = scenes.filter((scene) => scene.scenario.startsWith("github-pr-draft-"));
  assert.equal(prs.length, fixture.githubScenes.length, "Missing or duplicate PR evidence");
  const prSeen = new Set();
  for (const scene of prs) {
    const checks = scene.checks;
    const identity = `github-pr-draft-${checks.language}-${checks.appearance}-${checks.width}`;
    assert.equal(scene.scenario, identity);
    assert.ok(!prSeen.has(identity), "Duplicate PR evidence");
    prSeen.add(identity);
    assert.ok(
      fixture.githubScenes.some(
        (expected) =>
          expected.language === checks.language &&
          expected.appearance === checks.appearance &&
          expected.width === checks.width &&
          expected.height === checks.height,
      ),
      "Unexpected PR scene",
    );
    assert.deepEqual(checks.form, fixture.github, "Different literal PR form");
    for (const key of [
      "passed",
      "actualToolsSwitcher",
      "literalInputRetained",
      "readableFields",
      "workspaceVisibleAroundDialog",
      "terminalGenerationRetained",
      "savedWorkspaceUnchanged",
      "isolatedSimulatedCLI",
      "noGitHubWrites",
      "actualCancelPreservedState",
    ])
      assert.equal(checks[key], true, `Unaccepted ordinary PR: ${key}`);
    for (const key of ["modalLeft", "modalTop", "modalWidth", "modalHeight"])
      assert.ok(Number.isFinite(checks[key]), `Missing actual PR geometry: ${key}`);
    assert.ok(
      Math.abs(checks.modalWidth - Math.min(640, checks.width * 0.92)) < 1,
      "PR is limited to the tools viewport",
    );
    assert.ok(
      checks.modalHeight >= 40 && checks.modalHeight <= checks.height - 48,
      "PR form is clipped",
    );
    assert.ok(
      Math.abs(checks.modalLeft - (checks.width - checks.modalWidth) / 2) < 1 &&
        Math.abs(checks.modalTop - (checks.height - checks.modalHeight) / 2) < 1,
      "PR form is not centered",
    );
  }
}
