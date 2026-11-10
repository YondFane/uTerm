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
  assert.deepEqual([...actual].sort(), expected.sort(), "Incomplete ordinary-client parity grid");
}
