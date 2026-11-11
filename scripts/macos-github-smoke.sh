#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" "$PWD/tests/fixtures/github-cli.py" <<'PY'
import hashlib, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
app, evidence, fixture = map(Path, sys.argv[1:]); evidence.mkdir(parents=True, exist_ok=True)
report = evidence / 'github-native.json'; report.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-github-') as directory:
    root = Path(directory).resolve(); tools = root / 'tools'; tools.mkdir()
    program = tools / 'gh'; shutil.copyfile(fixture, program); program.chmod(0o700)
    environment = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ['PATH'],
                       UTERM_GITHUB_FIXTURE_ROOT=str(root), GH_REPO='unrelated/repository')
    for key in ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']:
        environment.pop(key, None)
    with (evidence / 'github-native-stdout.log').open('w') as out, (evidence / 'github-native-stderr.log').open('w') as err:
        process = subprocess.Popen([str(app / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', str(root), '--github-smoke-report', str(report)], env=environment, stdout=out, stderr=err)
        try: code = process.wait(timeout=150)
        finally:
            if process.poll() is None: process.kill(); process.wait()
            if (root / 'github-cli.jsonl').exists(): shutil.copyfile(root / 'github-cli.jsonl', evidence / 'github-cli-simulated.jsonl')
    assert code == 0, code
    data = json.loads(report.read_text())
    assert 'failure' not in data, data.get('failure')
    assert 'cleanupError' not in data, data.get('cleanupError')
    assert data['coreReady'] and not data['productionDataAccess']
    assert data['bundleIdentifier'] == 'sh.uterm.desktop.qa.native'
    for key in ['githubNativeRootMethodAndPrivateParameterBoundaries', 'nativeGithubMarkdownAssociationAndLinkedSession',
                'nativeGithubPRDetailsAndDiff', 'nativeGithubOfflineFailureVisibleAndRetryRecovered',
                'nativeGithubCancellationRetainsPendingOperationUntilCLICompletes', 'nativeGithubHideReopenAndQuitCancelRetainDraft',
                'nativeGithubMainWindowToolsAndCloseRetainDraft',
                'nativeGithubActualFilesSwitcherRetainsSessions',
                'nativeGithubPRModalRejectsRootInjectionAndInvalidLayout', 'nativeGithubPRModalWholeWorkspaceReadableFields',
                'nativeGithubPRModalActualEscapeAndExplicitCancel',
                'nativeGithubExplicitCreateLiteralPayloadAndPendingQuitGuard', 'nativeGithubBilingualThemeAndCleanQuitResume',
                'explicitFixtureCloseAndIdleHostShutdown']:
        assert data[key], key
    assert len(data['captures']) == 4
    for name in data['captures']: assert (evidence / name).stat().st_size > 1000, name
    assert data['sourceHeadSHA'] == os.environ.get('PR_HEAD_SHA', data['sourceHeadSHA'])
    assert not subprocess.check_output(['git', 'status', '--porcelain'])
    data.update(passed=True, testedMergeSHA=data['sourceSHA'], sourceTreeDirty=False, processExitCode=code,
                cliFixtureSHA256=hashlib.sha256(fixture.read_bytes()).hexdigest(), realGitHubRequests=False)
    report.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n'); print(json.dumps(data, ensure_ascii=False))
PY
