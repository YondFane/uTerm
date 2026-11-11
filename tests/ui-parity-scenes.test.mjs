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
  ...fixture.contentScenes.map(
    (scene) => `pdf-highlights-${scene.language}-${scene.appearance}-${scene.width}`,
  ),
];

const pdfEvidence = fixture.contentScenes.map((scene) => ({
  scenario: `pdf-highlights-${scene.language}-${scene.appearance}-${scene.width}`,
  checks: {
    ...scene,
    passed: true,
    pdfSHA256: fixture.pdf.sha256,
    markID: fixture.pdf.mark.id,
    marksCount: 1,
    actualRemoveButton: true,
    reopenedRestoredMarks: true,
    originalPdfUnchanged: true,
    inMainWorkspace: true,
    settingsPreserveDocument: true,
  },
}));
const assertOperations = (records) => assertParityOperations([...records, ...pdfEvidence], fixture);

test("the complete grid and required restart accept file-system enumeration order", () => {
  assert.equal(scenes.length, 35);
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
  assert.doesNotThrow(() => assertOperations([record]));
  assert.throws(() => assertOperations([]));
  assert.throws(() => assertOperations([record, record]));
  for (const key of Object.keys(checks)) {
    assert.throws(() => assertOperations([{ ...record, checks: { ...checks, [key]: null } }]));
  }
  assert.throws(() =>
    assertOperations([{ ...record, checks: { ...checks, restartedGeneration: "old-generation" } }]),
  );
});

test("PDF proof rejects missing, duplicate, stale data and unexecuted controls", () => {
  const restart = {
    scenario: "terminal-restart",
    checks: {
      passed: true,
      actualRestartButton: true,
      parsedUnicodeOutput: true,
      canonicalWorkspaceRetained: true,
      terminalViewRetained: true,
      generationBeforeRestart: "a",
      restartedGeneration: "b",
    },
  };
  for (const key of Object.keys(pdfEvidence[0].checks)) {
    const rows = structuredClone(pdfEvidence);
    rows[0].checks[key] = null;
    assert.throws(() => assertParityOperations([restart, ...rows], fixture), key);
  }
  for (const rows of [[], pdfEvidence.slice(1), [pdfEvidence[0], pdfEvidence[0]]])
    assert.throws(() => assertParityOperations([restart, ...rows], fixture));
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
