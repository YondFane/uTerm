#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
cargo build --locked --manifest-path crates/uterm-core/Cargo.toml --bin uterm-core-contract
git_qa_target="${CARGO_TARGET_DIR:-$PWD/crates/uterm-core/target}"
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" "$git_qa_target/debug/uterm-core-contract" <<'PY'
import json, subprocess, sys, tempfile, time
from pathlib import Path
app, evidence, writer = map(Path, sys.argv[1:])
evidence.mkdir(parents=True, exist_ok=True)
path = evidence / 'git-live.json'
path.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-') as root:
    with (evidence / 'git-stdout.log').open('w') as out, (evidence / 'git-stderr.log').open('w') as err:
        process = subprocess.Popen([str(app / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', root,
            '--git-smoke-report', str(path), '--qa-store-lock-helper', str(writer)], stdout=out, stderr=err)
        try:
            deadline = time.monotonic() + 150
            while process.poll() is None and time.monotonic() < deadline:
                if path.exists() and 'failure' in json.loads(path.read_text()):
                    subprocess.run(['sample', str(process.pid), '3', '-file', str(evidence / 'git-failure-termination-sample.txt')], timeout=10, check=False)
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait(timeout=10)
                    raise AssertionError(json.loads(path.read_text()))
                time.sleep(0.1)
            code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            subprocess.run(['sample', str(process.pid), '3', '-file', str(evidence / 'git-timeout-sample.txt')], timeout=10, check=False)
            process.kill()
            process.wait(timeout=10)
            raise
    assert code == 0, code
    report = json.loads(path.read_text())
    assert 'failure' not in report, report
    assert report['coreReady'] and not report['productionDataAccess'], report
    assert report['bundleIdentifier'] == 'sh.uterm.desktop.qa.native', report
    for key in ['realDiffAndHistory', 'copiedDiffThroughNativePasteboard', 'wrongRootRejected',
                'oldDocumentRejected', 'fileWindowCannotInvokeGit', 'branchFormSavedOpenEditorBeforeWrite',
                'dirtyWorktreeDeletionRefused', 'worktreeBridgeCreateAndCleanDelete',
                'editorConflictBlockedGitAndPreservedBothWriters', 'literalRootAndSiblingPreserved', 'narrowChineseLightGit',
                'wideDiffControlsWithinWindow', 'narrowPanelFillsWindow', 'worktreeSidebarRegisteredAndSelected',
                'worktreeRemovedFromSharedSidebar', 'rawWorktreeDeleteDenied', 'nativeDeleteCancelRetainedWorktree',
                'nativeDeleteMenuCompleted', 'nativeFavoritesUsedSharedCore', 'nativeFavoritesRetainedAfterReload',
                'favoriteRootDenied', 'favoriteContentImportDenied', 'fileWindowCannotReadGitFavorites',
                'contentCannotReadGlobalFavoriteRecovery',
                'favoriteRecoveryCancelRetainedBytes', 'favoriteRecoveryCopiedExactSourceWithoutRestore',
                'favoriteRecoveryOpenedFromScopedGitError', 'favoriteRecoveryStaleSelectionRetainedBytes',
                'favoriteRecoveryRestoredAndRetainedDamage', 'favoriteRecoveryMissingPreviewReadonlyAndExplicitRestore',
                'favoriteRecoveryReadyBeforeEditorWrite', 'favoriteRecoveryExplicitBusyReload',
                'cancelledGitRetainedEditorFreezeUntilCompletion', 'cancelledGitReportedCompletedWriteAndRetainedBytes']:
        assert report[key], (key, report)
    assert len(report['gitCaptures']) == 15, report
    assert report['favoriteRecoveryWriter']['actualOSLock'] and report['favoriteRecoveryWriter']['releaseExitCode'] == 0, report
    assert report['favoriteRecoveryWriter']['explicitReloads'] == 1 and report['favoriteRecoveryWriter']['bytesRetained'], report
    for name in report['gitCaptures']:
        assert (evidence / name).is_file(), name
    report.update(passed=True, testedMergeSHA=report['sourceSHA'], platform='macOS',
        sourceTreeDirty=bool(subprocess.check_output(['git', 'status', '--porcelain'])),
        manualKeyboardIMEAcceptance=False, processExitCode=code)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    assert not report['sourceTreeDirty'], report
    print(json.dumps(report, ensure_ascii=False))
PY
