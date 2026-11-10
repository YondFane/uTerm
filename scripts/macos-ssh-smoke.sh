#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
PYTHONDONTWRITEBYTECODE=1 python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" <<'PY'
import json, os, subprocess, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / 'scripts'))
from ssh_qa_service import SSHService
app, evidence = map(Path, sys.argv[1:])
evidence.mkdir(parents=True, exist_ok=True)
report_path = evidence / 'ssh-live.json'
report_path.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-') as root:
    service = SSHService(Path(root) / 'ssh-fixture', evidence)
    try:
        with (evidence / 'ssh-stdout.log').open('w') as output, (evidence / 'ssh-stderr.log').open('w') as errors:
            process = subprocess.Popen([str(app / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', root,
                '--ssh-smoke-report', str(report_path), '--ssh-smoke-fixture', str(service.context)],
                env=service.environment(), stdout=output, stderr=errors)
            try:
                code = process.wait(timeout=180)
            except subprocess.TimeoutExpired:
                subprocess.run(['sample', str(process.pid), '3', '-file', str(evidence / 'ssh-timeout-sample.txt')], timeout=10, check=False)
                process.kill(); process.wait(timeout=10)
                raise
    finally:
        endpoint = Path(root) / 'local-daemon-v1/endpoint.json'
        if endpoint.exists():
            target = Path(os.environ.get('CARGO_TARGET_DIR', str(Path.cwd() / 'crates/uterm-core/target')))
            with (evidence / 'ssh-cleanup.log').open('w') as log:
                helper = subprocess.Popen([str(target / 'debug/uterm-core-contract'), '--serve', str(Path(root) / 'shared-state-v1')],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
                def call(method, params=None):
                    helper.stdin.write(json.dumps({'version': 1, 'id': 'ssh-qa-cleanup', 'method': method, 'params': params}) + '\n'); helper.stdin.flush()
                    response = json.loads(helper.stdout.readline())
                    assert 'error' not in response, response
                    return response.get('result')
                try:
                    call('host.configure', {'helper': str(app / 'Contents/Resources/bin/utermd-local')})
                    status = call('host.status')
                    for session in status.get('sessions', []):
                        call('host.close', {'id': session['spec']['id'], 'generation': session['generation']})
                    call('host.shutdownIdle')
                finally:
                    helper.stdin.close()
                    helper.wait(timeout=10)
        service.close()
    assert code == 0, code
    report = json.loads(report_path.read_text())
    assert 'failure' not in report, report
    assert 'cleanupError' not in report, report
    assert report['coreReady'] and not report['productionDataAccess'], report
    for key in ['nativeSSHMenuAndProfileSaved', 'profileCASRetainedDraft', 'realAuthenticatedSFTPUploadAndDownload',
                'nativeTransferProgressAndGenerationCancel', 'nativeForwardingStarted', 'nativeForwardingBannerReceived',
                'nativeForwardingStaleStopRejected', 'realRemoteTerminalOutput', 'remoteDetachReplayAndHostRetained',
                'exactRemoteClosePreservedSibling', 'nativeAskpassHostTrustCancellation', 'passwordNotExportedOrReported']:
        assert report[key], (key, report)
    password_required = os.environ.get('GITHUB_ACTIONS') == 'true'
    assert report['passwordServiceLogin'] == password_required, report
    if password_required:
        assert report['actualPasswordRemoteTerminal'], report
        assert report['remotePromptObservedBeforePasswordCommand'], report
        assert report['rememberedAndTemporaryPasswordConversion'], report
        assert report['temporaryPasswordSurvivedTerminalTransportReconnect'], report
        assert report['nativeAskpassHostTrustApprovedAndAuthenticated'], report
    assert len(report['sshCaptures']) == (10 if password_required else 7), report
    for name in report['sshCaptures']:
        assert (evidence / name).is_file(), name
    deadline = time.monotonic() + 5
    while endpoint.exists() and time.monotonic() < deadline: time.sleep(0.05)
    assert not endpoint.exists(), 'Isolated SSH session host was not cleaned up'
    report.update(passed=True, testedMergeSHA=report['sourceSHA'], sourceTreeDirty=bool(subprocess.check_output(['git', 'status', '--porcelain'])),
        realService='Isolated privileged OpenSSH sshd/internal-sftp with temporary keys and known_hosts',
        cleanup=True, processExitCode=code)
    assert not report['sourceTreeDirty'], report
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))
PY
