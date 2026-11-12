#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" <<'PY'
import datetime, json, os, subprocess, sys, tempfile
from pathlib import Path
app, evidence = map(Path, sys.argv[1:])
evidence.mkdir(parents=True, exist_ok=True)
report = evidence / 'agent-native.json'
report.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-agent-') as directory:
    root = Path(directory)
    claude = root / 'agent-home/.claude'
    usage = claude / 'projects/qa/usage.jsonl'
    usage.parent.mkdir(parents=True)
    (claude / 'settings.json').write_text(json.dumps({'keep': 'private fixture', 'hooks': {'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': 'other-tool --start'}]}]}}))
    usage.write_text(json.dumps({'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'message': {'id': 'qa-usage', 'usage': {'input_tokens': 17, 'output_tokens': 8}}}) + '\n')
    with (evidence / 'agent-native-stdout.log').open('w') as out, (evidence / 'agent-native-stderr.log').open('w') as err:
        process = subprocess.Popen([str(app / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', str(root), '--agent-smoke-report', str(report)], stdout=out, stderr=err)
        try:
            code = process.wait(timeout=120)
        finally:
            if process.poll() is None:
                process.kill(); process.wait()
    assert code == 0, code
    data = json.loads(report.read_text())
    assert 'failure' not in data, data.get('failure')
    assert 'cleanupError' not in data, data.get('cleanupError')
    for key in ['usagePollingLoadsCatalogBeforeUsage', 'coreReady', 'openingDoesNotWriteDefaults', 'nativeCustomCommandSaveEnableDisableRemove', 'nativeHookPreservationDraftAndLocalUsage', 'actualApplicationQuitCancellationRetainsDraft', 'nativeNotificationOptInDenialDedupAndStaleCancellation', 'realHostAndReporterProcess', 'simulatedOSNotificationPermissionAndDelivery']:
        assert data[key], key
    assert not data['productionDataAccess'] and not data['actualAgentProvider'] and not data['keychainOrProviderAccountAccess']
    assert data['nativeUsageRefreshRespectsSelectedAgentAndLocalPreference']
    assert not data['automaticUsageKeychainAccess']
    assert data['bundleIdentifier'] == 'sh.uterm.desktop.qa.native'
    assert data['sourceHeadSHA'] == os.environ.get('PR_HEAD_SHA', data['sourceHeadSHA'])
    assert len(data['captures']) == 2
    for name in data['captures']:
        assert (evidence / name).stat().st_size > 1000, name
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain']))
    assert not dirty
    data.update(passed=True, testedMergeSHA=data['sourceSHA'], sourceTreeDirty=dirty, processExitCode=code)
    report.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(data, ensure_ascii=False))
PY
