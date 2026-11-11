import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertParityOperations, assertParityScenes } from "../scripts/ui-parity-scenes.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../shared/fixtures/client-ui-parity.json", import.meta.url), "utf8"),
);
const scenes = [
  "workspace-en-dark-1100",
  "workspace-en-dark-640",
  "workspace-en-light-1100",
  "workspace-en-light-640",
  "workspace-zh-Hans-dark-1100",
  "workspace-zh-Hans-dark-640",
  "workspace-zh-Hans-light-1100",
  "workspace-zh-Hans-light-640",
  ...fixture.settingsScenes.flatMap((scene) =>
    fixture.settingsSections.map(
      (section) => `settings-${section.id}-${scene.language}-${scene.appearance}-${scene.width}`,
    ),
  ),
  ...fixture.ordinaryOperations,
];

test("the complete grid and required restart accept file-system enumeration order", () => {
  assert.equal(scenes.length, 33);
  assert.doesNotThrow(() => assertParityScenes([...scenes].reverse(), fixture));
});

test("the ordinary restart requires actual controls, retained identity and a new generation", () => {
  const checks = {
    passed: true,
    actualRestartButton: true,
    parsedUnicodeOutput: true,
    canonicalWorkspaceRetained: true,
    terminalViewRetained: true,
    generationBeforeRestart: "old-generation",
    restartedGeneration: "new-generation",
  };
  const record = { scenario: "terminal-restart", checks };
  assert.doesNotThrow(() => assertParityOperations([record]));
  assert.throws(() => assertParityOperations([]));
  assert.throws(() => assertParityOperations([record, record]));
  for (const key of Object.keys(checks)) {
    assert.throws(() =>
      assertParityOperations([{ ...record, checks: { ...checks, [key]: null } }]),
    );
  }
  assert.throws(() =>
    assertParityOperations([
      { ...record, checks: { ...checks, restartedGeneration: "old-generation" } },
    ]),
  );
});

test("three-scene fallback, missing, duplicate, substituted and extra captures fail", () => {
  for (const actual of [
    scenes.slice(0, 3),
    scenes.slice(0, -1),
    [...scenes.slice(0, -1), scenes[0]],
    [...scenes.slice(0, -1), "settings-unknown-en-dark-900"],
    [...scenes, "failure"],
  ]) {
    assert.throws(() => assertParityScenes(actual, fixture), /Incomplete ordinary-client parity/);
  }
});

test("the required grid follows fixture changes instead of a hardcoded scene count", () => {
  const changed = structuredClone(fixture);
  changed.widths.push(800);
  assert.throws(() => assertParityScenes(scenes, changed), /Incomplete ordinary-client parity/);
  assert.doesNotThrow(() =>
    assertParityScenes(
      [
        ...scenes,
        ...fixture.languages.flatMap((language) =>
          fixture.appearances.map((appearance) => `workspace-${language}-${appearance}-800`),
        ),
      ],
      changed,
    ),
  );
});
