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
  expected.push(...fixture.ordinaryOperations);
  assert.deepEqual([...actual].sort(), expected.sort(), "Incomplete ordinary-client parity grid");
}

export function assertParityOperations(scenes) {
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
}
