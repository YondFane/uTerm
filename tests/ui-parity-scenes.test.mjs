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
  ...fixture.githubScenes.map(
    (scene) => `github-pr-draft-${scene.language}-${scene.appearance}-${scene.width}`,
  ),
  ...fixture.runPanelScenes.flatMap((scene) =>
    fixture.runPanelKinds.flatMap((kind) =>
      fixture.runPanelStates.map(
        (state) => `run-${kind}-${state}-${scene.language}-${scene.appearance}-${scene.width}`,
      ),
    ),
  ),
  ...fixture.ordinaryOperations,
  ...fixture.contentScenes.map(
    (scene) => `pdf-highlights-${scene.language}-${scene.appearance}-${scene.width}`,
  ),
  ...fixture.quickScenes.map(
    (scene) => `quick-ssh-invalid-${scene.language}-${scene.appearance}-${scene.width}`,
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
    fixtureSessionCount: 1,
    filesFolderExpanded: true,
    actualRemoveButton: true,
    reopenedRestoredMarks: true,
    originalPdfUnchanged: true,
    inMainWorkspace: true,
    settingsPreserveDocument: true,
  },
}));
const quickEvidence = fixture.quickScenes.map((scene) => ({
  scenario: `quick-ssh-invalid-${scene.language}-${scene.appearance}-${scene.width}`,
  checks: {
    ...scene,
    passed: true,
    inputAddress: fixture.quickAddress,
    terminalFixtureMarker: fixture.marker,
    invalidInputRejected: true,
    addressRetained: true,
    savedWorkspaceUnchanged: true,
    sameMainWindow: true,
    terminalGenerationRetained: true,
    actualSidebarButton: true,
    actualCancelPreservedState: true,
    workspaceVisibleAroundDialog: true,
    modalWidth: 540,
    modalHeight: 300,
    modalLeft: (scene.width - 540) / 2,
    modalTop: (scene.height - 300) / 2,
  },
}));
const prEvidence = fixture.githubScenes.map((scene) => ({
  scenario: `github-pr-draft-${scene.language}-${scene.appearance}-${scene.width}`,
  checks: {
    ...scene,
    passed: true,
    form: structuredClone(fixture.github),
    actualToolsSwitcher: true,
    literalInputRetained: true,
    readableFields: true,
    workspaceVisibleAroundDialog: true,
    terminalGenerationRetained: true,
    savedWorkspaceUnchanged: true,
    isolatedSimulatedCLI: true,
    noGitHubWrites: true,
    actualCancelPreservedState: true,
    modalWidth: Math.min(640, scene.width * 0.92),
    modalHeight: 500,
    modalLeft: (scene.width - Math.min(640, scene.width * 0.92)) / 2,
    modalTop: (scene.height - 500) / 2,
  },
}));
const runEvidence = fixture.runPanelScenes.flatMap((item) =>
  fixture.runPanelKinds.flatMap((kind) =>
    fixture.runPanelStates.map((state) => ({
      scenario: `run-${kind}-${state}-${item.language}-${item.appearance}-${item.width}`,
      checks: {
        ...item,
        kind,
        state,
        passed: true,
        actualToolbarButton: true,
        actualExpandAndRestore: true,
        retainedPanelView: true,
        terminalGenerationRetained: true,
        canonicalWorkspaceRetained: true,
        fileVisible: state === "file",
        panelLeft: 100,
        panelTop: 240,
        panelWidth: item.width - 200,
        panelHeight: 480,
      },
    })),
  ),
);
const runCleanup = {
  scenario: "run-panels-complete",
  checks: {
    passed: true,
    actualFileCloseAndHideVerified: true,
    terminalGenerationRetained: true,
    canonicalWorkspaceRetained: true,
  },
};
const assertOperations = (records) =>
  assertParityOperations(
    [...records, ...pdfEvidence, ...quickEvidence, ...prEvidence, ...runEvidence, runCleanup],
    fixture,
  );

test("the complete grid and required restart accept file-system enumeration order", () => {
  assert.equal(scenes.length, 52);
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
  assert.doesNotThrow(() =>
    assertParityOperations(
      [restart, ...pdfEvidence, ...quickEvidence, ...prEvidence, ...runEvidence, runCleanup],
      fixture,
    ),
  );
  for (const key of Object.keys(pdfEvidence[0].checks)) {
    const rows = structuredClone(pdfEvidence);
    rows[0].checks[key] = null;
    assert.throws(
      () =>
        assertParityOperations(
          [restart, ...rows, ...quickEvidence, ...prEvidence, ...runEvidence, runCleanup],
          fixture,
        ),
      key,
    );
  }
  for (const rows of [[], pdfEvidence.slice(1), [pdfEvidence[0], pdfEvidence[0]]])
    assert.throws(() =>
      assertParityOperations(
        [restart, ...rows, ...quickEvidence, ...prEvidence, ...runEvidence, runCleanup],
        fixture,
      ),
    );
});

test("Quick SSH pairing rejects missing controls, data changes and stale fixture values", () => {
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
  assert.doesNotThrow(() =>
    assertParityOperations(
      [restart, ...pdfEvidence, ...quickEvidence, ...prEvidence, ...runEvidence, runCleanup],
      fixture,
    ),
  );
  for (const key of Object.keys(quickEvidence[0].checks)) {
    const rows = structuredClone(quickEvidence);
    rows[0].checks[key] = null;
    assert.throws(
      () =>
        assertParityOperations(
          [restart, ...pdfEvidence, ...rows, ...prEvidence, ...runEvidence, runCleanup],
          fixture,
        ),
      key,
    );
  }
  for (const rows of [[], quickEvidence.slice(1), [quickEvidence[0], quickEvidence[0]]])
    assert.throws(() =>
      assertParityOperations(
        [restart, ...pdfEvidence, ...rows, ...prEvidence, ...runEvidence, runCleanup],
        fixture,
      ),
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

test("PR scenes reject tool-width forms, changed literals, missing operations and duplicate scenes", () => {
  const restart = {
    scenario: "terminal-restart",
    checks: {
      passed: true,
      actualRestartButton: true,
      parsedUnicodeOutput: true,
      canonicalWorkspaceRetained: true,
      terminalViewRetained: true,
      generationBeforeRestart: "before",
      restartedGeneration: "after",
    },
  };
  const verify = (rows) =>
    assertParityOperations(
      [restart, ...pdfEvidence, ...quickEvidence, ...rows, ...runEvidence, runCleanup],
      fixture,
    );
  assert.doesNotThrow(() => verify(prEvidence));
  for (const patch of [
    { modalWidth: 128 },
    { modalTop: 0 },
    { modalHeight: 720 },
    { noGitHubWrites: false },
    { readableFields: false },
    { literalInputRetained: false },
    { form: { ...fixture.github, body: "changed" } },
  ]) {
    const rows = structuredClone(prEvidence);
    Object.assign(rows[0].checks, patch);
    assert.throws(() => verify(rows));
  }
  for (const rows of [[], prEvidence.slice(1), [prEvidence[0], prEvidence[0]]])
    assert.throws(() => verify(rows));
});

test("run-panel proof rejects unexecuted controls, duplicate scenes, invalid frames and missing cleanup", () => {
  const restart = {
    scenario: "terminal-restart",
    checks: {
      passed: true,
      actualRestartButton: true,
      parsedUnicodeOutput: true,
      canonicalWorkspaceRetained: true,
      terminalViewRetained: true,
      generationBeforeRestart: "before",
      restartedGeneration: "after",
    },
  };
  const verify = (rows, cleanup = runCleanup) =>
    assertParityOperations(
      [
        restart,
        ...pdfEvidence,
        ...quickEvidence,
        ...prEvidence,
        ...rows,
        ...(cleanup ? [cleanup] : []),
      ],
      fixture,
    );
  assert.doesNotThrow(() => verify(runEvidence));
  for (const field of [
    "actualToolbarButton",
    "actualExpandAndRestore",
    "retainedPanelView",
    "terminalGenerationRetained",
    "canonicalWorkspaceRetained",
    "fileVisible",
    "panelWidth",
  ]) {
    const rows = structuredClone(runEvidence);
    rows[0].checks[field] = null;
    assert.throws(() => verify(rows), field);
  }
  assert.throws(() => verify([...runEvidence.slice(1), runEvidence[1]]));
  assert.throws(() => verify(runEvidence.slice(1)));
  assert.throws(() => verify(runEvidence, null));
  const rows = structuredClone(runEvidence);
  rows[0].checks.panelTop = 900;
  assert.throws(() => verify(rows));
});
