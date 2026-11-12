#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
: "${JAVA_HOME:?Set JAVA_HOME to JDK 21}"
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" "$JAVA_HOME" <<'PY'
import json, subprocess, sys, tempfile, time
from pathlib import Path
app, evidence, home = map(Path, sys.argv[1:])
evidence.mkdir(parents=True, exist_ok=True)
path = evidence / 'java-live.json'
path.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-') as directory:
    root = Path(directory)
    project = root / 'java-project 中文'
    target = project / 'target'
    target.mkdir(parents=True)
    (project / 'TaskProbe.java').write_text(r'''
import java.nio.file.*;
public class TaskProbe {
    public static void main(String[] args) throws Exception {
        Runtime.getRuntime().addShutdownHook(new Thread(() -> { System.out.println("STOP_CLEANUP"); System.out.flush(); }));
        System.out.println("READY:" + args[0] + ":" + System.getenv("VALUE") + ":" + System.getProperty("qa.value") + ":empty=" + args[1].isEmpty());
        if (args.length > 2) {
            System.out.println("LONG_READY 中文");
            for (int i = 0; i < 120; i++) System.out.println("BEFORE_PAUSE_" + i);
            System.out.flush();
            while (!Files.exists(Path.of("qa-continue"))) Thread.sleep(20);
            for (int i = 0; i < 120; i++) System.out.println("AFTER_PAUSE_" + i);
            System.out.flush();
            Thread.sleep(60000);
        }
        System.out.println("LAST:中文 e\u0301");
        System.err.println("ERR_LAST:中文");
        System.exit(7);
    }
}
''', encoding='utf-8')
    with (evidence / 'java-fixture-build.log').open('w') as log:
        subprocess.run([str(home / 'bin/javac'), '-encoding', 'UTF-8', '-d', 'target', 'TaskProbe.java'], cwd=project, check=True, stdout=log, stderr=log)
        subprocess.run([str(home / 'bin/jar'), '--create', '--file', 'target/literal 中文 & %.jar', '--main-class', 'TaskProbe', '-C', 'target', 'TaskProbe.class'], cwd=project, check=True, stdout=log, stderr=log)
    (project / 'pom.xml').write_text('<project><modelVersion>4.0.0</modelVersion><groupId>qa</groupId><artifactId>literal</artifactId><version>1</version></project>')
    wrapper = project / '.mvn/wrapper'
    wrapper.mkdir(parents=True)
    (wrapper / 'maven-wrapper.properties').write_text('distributionUrl=invalid:must-not-download\n')
    with (evidence / 'java-stdout.log').open('w') as out, (evidence / 'java-stderr.log').open('w') as err:
        process = subprocess.Popen([str(app / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', str(root),
            '--java-smoke-report', str(path), '--java-qa-home', str(home)], stdout=out, stderr=err)
        try:
            code = process.wait(timeout=150)
        except subprocess.TimeoutExpired:
            with (evidence / 'java-timeout-sample.txt').open('w') as sample:
                subprocess.run(['sample', str(process.pid), '1'], stdout=sample, stderr=sample, timeout=10, check=False)
            process.kill(); process.wait(timeout=10)
            raise
    assert code == 0, code
    report = json.loads(path.read_text())
    assert 'failure' not in report and 'cleanupError' not in report, report
    assert report['coreReady'] and not report['productionDataAccess'], report
    for key in ['nativeJavaMenuOpened', 'nativeJDKRegistration', 'configurationConflictRetainedDraft',
                'realJARFinalOutputAndExitCode', 'existingJarBypassedInvalidWrapper', 'windowDetachRetainedTask',
                'reopenedSameGenerationAndHost', 'staleGenerationStopRefused', 'forceStopCompleted',
                'temporaryEnvironmentNotSaved', 'nativeLogSearchFoundLiteralOutput',
                'nativePausedFollowRetainedAnchor', 'nativeFollowResumed', 'runAgainWaitedForOldExit',
                'normalStopRetainedFinalOutputAndCopy']:
        assert report[key], (key, report)
    assert report['unsupportedDevelopmentArgumentsRejected'], report
    proof = report['javaToolbarRunList']
    for field in ['passed', 'realHostTask', 'actualMenuAction', 'staleGenerationRejected', 'scopeRetainedOnRejection', 'sameTaskGeneration', 'actualMainWindow']:
        assert proof[field] is True, (field, proof)
    for name in [proof['screenshot'], report['nativeJavaMenuWorkspaceCapture']]:
        assert (evidence / name).stat().st_size > 1000, name
    assert len(report['javaCaptures']) == 5, report
    for name in report['javaCaptures']:
        assert (evidence / name).is_file(), name
    endpoint = root / 'local-daemon-v1/endpoint.json'
    deadline = time.monotonic() + 5
    while endpoint.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not endpoint.exists(), 'Private Java host was not cleaned up'
    report.update(passed=True, testedMergeSHA=report['sourceSHA'], platform='macOS',
        sourceTreeDirty=bool(subprocess.check_output(['git', 'status', '--porcelain'])),
        manualKeyboardIMEAcceptance=False, manualPickerAcceptance=False, processExitCode=code)
    assert not report['sourceTreeDirty'], report
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))
PY
