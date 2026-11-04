#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" <<'PY'
import json, subprocess, sys, tempfile, time
from pathlib import Path
app, evidence = map(Path, sys.argv[1:])
evidence.mkdir(parents=True, exist_ok=True)
path = evidence / 'python-live.json'
path.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-') as root:
    with (evidence / 'python-stdout.log').open('w') as out, (evidence / 'python-stderr.log').open('w') as err:
        process = subprocess.Popen([str(app / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', root,
            '--python-smoke-report', str(path), '--python-qa-interpreter', sys.executable], stdout=out, stderr=err)
        try:
            code = process.wait(timeout=150)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(timeout=10)
            raise
    assert code == 0, code
    report = json.loads(path.read_text())
    assert 'failure' not in report, report
    assert 'cleanupError' not in report, report
    assert report['coreReady'] and not report['productionDataAccess'], report
    for key in ['nativePythonMenuOpened', 'configurationConflictRetainedDraft', 'realPythonFinalOutputAndExitCode',
                'windowDetachRetainedTask', 'reopenedSameGenerationAndReplay', 'staleGenerationStopRefused',
                'forceStopCompleted', 'temporaryEnvironmentNotSaved']:
        assert report[key], (key, report)
    assert len(report['pythonCaptures']) == 3, report
    for name in report['pythonCaptures']:
        assert (evidence / name).is_file(), name
    endpoint = Path(root) / 'local-daemon-v1/endpoint.json'
    deadline = time.monotonic() + 5
    while endpoint.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not endpoint.exists(), 'Private Python host was not cleaned up'
    report.update(passed=True, testedMergeSHA=report['sourceSHA'], platform='macOS',
        sourceTreeDirty=bool(subprocess.check_output(['git', 'status', '--porcelain'])),
        manualKeyboardIMEAcceptance=False, processExitCode=code)
    assert not report['sourceTreeDirty'], report
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))
PY
