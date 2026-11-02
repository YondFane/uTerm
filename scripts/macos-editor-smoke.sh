#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" <<'PY'
import json, os, signal, subprocess, sys, tempfile, time
from pathlib import Path

app, evidence = map(Path, sys.argv[1:])
evidence.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-') as root:
    reports = {}
    for phase in ['checkpoint', 'reopen']:
        path = evidence / f'editor-{phase}.json'
        path.unlink(missing_ok=True)
        with (evidence / f'editor-{phase}-stdout.log').open('w') as out, (evidence / f'editor-{phase}-stderr.log').open('w') as err:
            process = subprocess.Popen([str(app / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', root,
                '--editor-smoke-report', str(path), '--editor-smoke-phase', phase], stdout=out, stderr=err)
            try:
                deadline = time.monotonic() + 90
                while not path.exists() and time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise AssertionError(f'{phase}: app exited before its report: {process.returncode}')
                    time.sleep(.05)
                assert path.exists(), f'{phase}: no report before timeout'
                report = json.loads(path.read_text())
                assert 'failure' not in report, report
                assert report['coreReady'] and not report['productionDataAccess'], report
                assert report['bundleIdentifier'] == 'sh.uterm.desktop.qa.native', report
                if phase == 'checkpoint':
                    for key in ['editedDraftDurableBeforeKill', 'originalBytesBeforeKill', 'wrongFileWriteRejected', 'awaitingForcedExit']:
                        assert report[key], (key, report)
                    assert process.poll() is None, 'Checkpoint app must be alive before forced exit'
                    os.kill(process.pid, signal.SIGKILL)
                    code = process.wait(timeout=10)
                    assert code == -signal.SIGKILL, code
                    report['forcedExitSignal'] = signal.SIGKILL
                else:
                    for key in ['forcedExitDraftRestored', 'externalConflictRetainedFileAndDraft', 'closeRefusedWithoutReadonlyFallback',
                                'discardRemovedOnlyOwnDraft', 'savedExactBytesAndClearedDraft', 'cleanEditorQuitPrepared',
                                'narrowEditorControlsWithinViewport', 'missingSourceRetainedReadonlyAfterClose']:
                        assert report[key], (key, report)
                    code = process.wait(timeout=20)
                    assert code == 0, code
                report['processExitCode'] = code
                path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
                for name in report['editorCaptures']:
                    assert (evidence / name).is_file(), name
                reports[phase] = report
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=10)
    assert reports['checkpoint']['sourceHeadSHA'] == reports['reopen']['sourceHeadSHA']
    assert reports['checkpoint']['sourceSHA'] == reports['reopen']['sourceSHA']
    summary = {'passed': True, 'sourceHeadSHA': reports['reopen']['sourceHeadSHA'],
        'testedMergeSHA': reports['reopen']['sourceSHA'], 'sourceTreeDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'])),
        'platform': 'macOS', 'architecture': reports['reopen']['architecture'], 'system': reports['reopen']['system'],
        'scenario': 'Real isolated native WK editor, durable draft, SIGKILL and relaunch, conflict/close/discard/save',
        'manualKeyboardIMEAcceptance': False, 'reports': ['editor-checkpoint.json', 'editor-reopen.json'],
        'captures': reports['checkpoint']['editorCaptures'] + reports['reopen']['editorCaptures']}
    (evidence / 'editor-live.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    assert not summary['sourceTreeDirty'], summary
    print(json.dumps(summary, ensure_ascii=False))
PY
