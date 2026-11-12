#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" <<'PY'
import json, os, subprocess, sys, tempfile
from pathlib import Path
app, evidence = map(Path, sys.argv[1:]); evidence.mkdir(parents=True, exist_ok=True)
report = evidence / 'settings-native.json'; report.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-settings-') as directory:
    with (evidence / 'settings-native-stdout.log').open('w') as out, (evidence / 'settings-native-stderr.log').open('w') as err:
        process = subprocess.Popen([str(app / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', directory, '--settings-smoke-report', str(report)], stdout=out, stderr=err)
        try: code = process.wait(timeout=120)
        finally:
            if process.poll() is None: process.kill(); process.wait()
    assert code == 0, code
    data = json.loads(report.read_text())
    assert 'failure' not in data, data.get('failure')
    assert data['coreReady'] and not data['productionDataAccess']
    for key in ['nativeSettingsMenuAndReadonlyOpen', 'invalidNumericDraftRetainedWithoutWrite', 'unrelatedExternalSettingsPreserved', 'sameFieldConflictRetainsDraftAndPeerValue', 'hiddenWindowAndActualQuitCancellationRetainDraft', 'nativeReservedAndDuplicateShortcutErrors', 'nativeShortcutCaptureAndSave', 'nativeDynamicMenuPaletteKeyboardAndFocusReturn', 'nativeThemeImportDraftFailureAndTerminalEffects', 'explicitResetUsesSharedDefaults', 'simulatedLoginItemOptInApprovalFailureAndDisable']:
        assert data[key], key
    proof = data['nativeSettingsSearchProof']
    for key in ['actualAppKitInput', 'filteredNavigation', 'matchingCategoryClickable', 'draftRetained', 'escapeClearsWithoutClosing', 'savedBytesUnchanged']:
        assert proof[key] is True, key
    assert (evidence / proof['capture']).stat().st_size > 1000
    proof = data['nativeSettingsAutomaticSaveProof']
    for key in ['actualFieldEditorBlur', 'actualFieldEditorEnter', 'enterRetainsUnrelatedDraft', 'invalidDraftRetainedWithoutWrite', 'correctedFieldSavedAutomatically', 'actualFontPicker', 'scopedWrite', 'otherDraftRetained', 'peerWriteConflictRetained', 'actualThemePreviewSelection', 'terminalThemeUnchanged', 'explicitReloadRecovery']:
        assert proof[key] is True, key
    assert (evidence / proof['capture']).stat().st_size > 1000
    assert len(proof['themeCaptures']) == 2
    for name in proof['themeCaptures']: assert (evidence / name).stat().st_size > 1000, name
    proof = data['nativeSettingsOverlayProof']
    for key in ['realWorkspaceChildWindow', 'actualCloseButton', 'workspaceFocusRestored', 'sameCachedWindowReopened', 'minimumWindow640x420']:
        assert proof[key] is True, key
    assert (evidence / proof['capture']).stat().st_size > 1000
    assert data['nativeThemeFileNamesAndBoundedReads']
    assert data['nativeFontPickersPreserveCustomDraftsAndSaveSharedPresets']
    assert data['nativeGlobalMavenActualSaveConflictDraftAndProjectPreservation']
    assert data['nativeDatabaseComponentsReadonlyCatalogWithoutDownloads']
    assert data['nativeJavaCatalogDetectionRegistrationFailureRetentionAndRecordRemoval']
    assert data['nativeBreakReminderRenderDismissAndDisable']
    assert data['nativeFileTabLimitConflictRetainsDraftAndExplicitCloseAllowsRetry']
    assert data['nativeLowerFileTabLimitAppliesToExistingTabs']
    for name in data['preferenceCaptures']: assert (evidence / name).stat().st_size > 1000, name
    assert not data['actualOSLoginRegistrationExecuted']
    assert len(data['captures']) == 8
    for name in data['captures']: assert (evidence / name).stat().st_size > 1000, name
    assert data['sourceHeadSHA'] == os.environ.get('PR_HEAD_SHA', data['sourceHeadSHA'])
    assert not subprocess.check_output(['git', 'status', '--porcelain'])
    data.update(passed=True, testedMergeSHA=data['sourceSHA'], sourceTreeDirty=False, processExitCode=code)
    report.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n'); print(json.dumps(data, ensure_ascii=False))
PY
