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
report = evidence / 'inspector-native.json'; report.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-inspector-') as directory:
    with (evidence / 'inspector-native-stdout.log').open('w') as out, (evidence / 'inspector-native-stderr.log').open('w') as err:
        process = subprocess.Popen([str(app / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', directory, '--inspector-smoke-report', str(report)], stdout=out, stderr=err)
        try: code = process.wait(timeout=210)
        finally:
            if process.poll() is None: process.kill(); process.wait()
    assert code == 0, code
    data = json.loads(report.read_text())
    assert 'failure' not in data, data.get('failure')
    assert 'cleanupError' not in data, data.get('cleanupError')
    assert data['coreReady'] and not data['productionDataAccess']
    assert data['bundleIdentifier'] == 'sh.uterm.desktop.qa.native'
    for key in ['nativeFilesHiddenNavigationAndSymlinkBoundary', 'nativeInspectorQueryFocusSurvivesPTYOutput', 'nativeSearchReturnOpenedExactLine',
                'sharedFilesRootAndMethodBoundaries', 'sharedFilesActualCreateCopyRenameDeleteAndCancel', 'sharedFilesStaleProjectRejected', 'sharedFilesAcrossProjectsRetainCopiedSource',
                'sharedFilesAcrossWorkspacesRetainCopiedSourceAndRejectRemovedRoots',
                'nativeSSHSearchAllAndCategoryRetainFocusAndSessions', 'nativeQuickSSHInvalidCancelAndStaleWorkspacePreserveState', 'nativeQuickSSHActualCreateAndKeepRetainSession',
                'nativeQuickSSHActualFinalSessionPrunesTemporary', 'nativeQuickSSHInMainWindow', 'nativeQuickSSHModalCloseKeysRetainState', 'nativeQuickSSHModalRetainsExistingSessions', 'nativeQuickSSHFormBoundsAndLayoutArguments', 'nativeQuickSSHActualBackdropCancelRetainsState',
                'searchJumpRetainsExistingEditorText', 'cancelledSearchAndFilenameQuickOpen',
                'paneSwapAndZoomRetainLayoutViewsAndOutput', 'closeFocusedToolsRetainsPTYAndReturnsFocus',
                'leftToolsRemainVisibleWithoutSidebar', 'explicitFixtureCloseAndIdleHostShutdown']:
        assert data[key], key
    assert type(data['nativeQuickSSHActualOpenCount']) is int and data['nativeQuickSSHActualOpenCount'] == 6
    assert len(data['captures']) == 9
    for name in data['captures']: assert (evidence / name).stat().st_size > 1000, name
    assert data['sourceHeadSHA'] == os.environ.get('PR_HEAD_SHA', data['sourceHeadSHA'])
    assert not subprocess.check_output(['git', 'status', '--porcelain'])
    data.update(passed=True, testedMergeSHA=data['sourceSHA'], sourceTreeDirty=False, processExitCode=code)
    report.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n'); print(json.dumps(data, ensure_ascii=False))
PY
