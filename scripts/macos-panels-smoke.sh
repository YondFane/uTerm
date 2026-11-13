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
report = evidence / 'workspace-panels-native.json'; report.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-panels-') as directory:
    with (evidence / 'workspace-panels-stdout.log').open('w') as out, (evidence / 'workspace-panels-stderr.log').open('w') as err:
        process = subprocess.Popen([str(app / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', directory, '--panels-smoke-report', str(report)], stdout=out, stderr=err)
        try: code = process.wait(timeout=240)
        finally:
            if process.poll() is None: process.kill(); process.wait()
    assert code == 0, code
    data = json.loads(report.read_text())
    assert 'failure' not in data, data.get('failure')
    assert data['directNativePanelSwitchRetainsAndRemountsExactViews'] is True
    assert data['coreReady'] and not data['productionDataAccess']
    assert data['bundleIdentifier'] == 'sh.uterm.desktop.qa.native'
    required = {
        **{kind: ['retainedViewAfterTabSwitch', 'terminalGenerationRetained', 'actualCloseButton'] for kind in ['java', 'python', 'ssh']},
        **{kind: ['initialSelectionDelivered', 'retainedDocumentAfterReopen', 'actualCloseButton'] for kind in ['database', 'redis']},
        'git': ['toolsSwitcher', 'retainedDocumentAfterModeSwitch'],
    }
    for kind, fields in required.items():
        proof = data[kind + 'WorkspacePanelProof']
        for key in ['actualMainWindow', *fields]: assert proof[key] is True, (kind, key)
    project = data['nativeProjectMenuRevisionAndWorkspaceMove']
    for key in ['passed', 'actualMenuActions', 'stalePinRejected', 'staleMoveRejected', 'peerSettingRetained', 'terminalGenerationsAndViewsRetained', 'splitLayoutRetainedInReopenedSnapshot', 'movedAndReturned']:
        assert project[key] is True, key
    drag = project.get("dragSimulation", {})
    for key in ["passed", "actualNSTableViewCallbacks", "ownedPasteboard", "foreignSourceRejected", "forgedPayloadRejected", "cancelledDragRejected", "staleRevisionRejected", "freshDropAndReverseVerified"]:
        assert drag.get(key) is True, key
    assert project['sourceHeadSHA'] == data['sourceHeadSHA'] and project['testedMergeSHA'] == data['sourceSHA']
    assert (evidence / project['screenshot']).stat().st_size > 1000
    attempts = data['profileFixtureWriteAttempts']
    assert set(attempts) == {'database', 'redis'}
    assert all(type(value) is int and 1 <= value <= 3 for value in attempts.values())
    assert type(data['profileFixtureReadRetries']) is int and data['profileFixtureReadRetries'] >= 0
    assert data['cleanup']
    expected = {(kind, language, appearance, width) for kind in ['java', 'python', 'ssh', 'database', 'redis', 'git']
                for language, appearance, width in [('en', 'dark', 1100), ('zh-Hans', 'light', 640)]}
    assert len(data['scenes']) == len(expected)
    assert {(scene['scenario'], scene['language'], scene['appearance'], scene['width']) for scene in data['scenes']} == expected
    for scene in data['scenes']:
        assert scene['sourceHeadSHA'] == data['sourceHeadSHA'] and scene['testedMergeSHA'] == data['sourceSHA']
        assert scene['platform'] == 'macOS' and scene['architecture'] == data['architecture'] and scene['system'] == data['system']
        assert scene['height'] == 720 and scene['screenshot'] in data['captures']
    assert len(data['captures']) == 12
    for name in data['captures']: assert (evidence / name).stat().st_size > 1000, name
    assert data['sourceHeadSHA'] == os.environ.get('PR_HEAD_SHA', data['sourceHeadSHA'])
    assert not subprocess.check_output(['git', 'status', '--porcelain'])
    data.update(passed=True, testedMergeSHA=data['sourceSHA'], sourceTreeDirty=False, processExitCode=code)
    report.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n'); print(json.dumps(data, ensure_ascii=False))
PY
