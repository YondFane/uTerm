#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
native_db_prefix="$(brew --prefix postgresql@16)"
if [ ! -x "$native_db_prefix/bin/initdb" ]; then
  HOMEBREW_NO_AUTO_UPDATE=1 brew install postgresql@16
fi
export UTERM_QA_POSTGRES_BIN="$native_db_prefix/bin"
python3 -B - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" <<'PY'
import hashlib, json, os, secrets, socket, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path('scripts').resolve()))
from database_qa_service import fetch_postgres_driver
app, evidence = map(Path, sys.argv[1:])
evidence.mkdir(parents=True, exist_ok=True)
binary = Path(os.environ['UTERM_QA_POSTGRES_BIN'])
report_path = evidence / 'database-live.json'
report_path.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-database-') as directory:
    root = Path(directory)
    password = secrets.token_hex(24)
    password_file = root / 'password'
    password_file.write_text(password + '\n'); password_file.chmod(0o600)
    driver = root / 'postgresql.jar'
    artifact = json.loads(Path('components/database/catalog.json').read_text())['drivers']['postgresql']
    driver_report = fetch_postgres_driver(driver)
    driver_report.update(sourceHeadSHA=os.environ.get('PR_HEAD_SHA') or subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                         testedMergeSHA=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip())
    (evidence / 'database-jdbc.json').write_text(json.dumps(driver_report, indent=2) + '\n')
    data = root / 'postgres-data'
    with (evidence / 'database-postgres-init.log').open('w') as log:
        subprocess.run([str(binary / 'initdb'), '-D', str(data), '--username=uterm_qa', '--pwfile=' + str(password_file), '--auth-local=trust', '--auth-host=scram-sha-256', '--encoding=UTF8', '--no-locale'], check=True, stdout=log, stderr=subprocess.STDOUT)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
    with (data / 'postgresql.conf').open('a') as config:
        config.write("\nlisten_addresses='127.0.0.1'\nport=" + str(port) + "\nunix_socket_directories=''\n")
    postgres_log = evidence / 'database-postgres.log'
    process = None
    try:
        subprocess.run([str(binary / 'pg_ctl'), '-D', str(data), '-l', str(postgres_log), '-w', '-t', '20', 'start'], check=True)
        database_env = dict(os.environ, PGPASSWORD=password)
        subprocess.run([str(binary / 'createdb'), '-h', '127.0.0.1', '-p', str(port), '-U', 'uterm_qa', 'uterm_qa'], env=database_env, check=True)
        application_env = dict(os.environ, UTERM_NATIVE_DATABASE_PASSWORD=password, UTERM_NATIVE_DATABASE_PORT=str(port), UTERM_NATIVE_DATABASE_DRIVER=str(driver))
        with (evidence / 'database-stdout.log').open('w') as out, (evidence / 'database-stderr.log').open('w') as err:
            process = subprocess.Popen([str(app / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', str(root), '--database-smoke-report', str(report_path)], env=application_env, stdout=out, stderr=err)
            code = process.wait(timeout=180)
        assert code == 0, code
        report = json.loads(report_path.read_text())
        assert 'failure' not in report, report.get('failure')
        assert 'cleanupError' not in report, report.get('cleanupError')
        assert report['coreReady'] and not report['productionDataAccess']
        for key in ['nativeProfileSaveWithoutPasswordPersistence', 'nativeRealPostgresqlConnection', 'nativeSQLInputWaitedForReadyControls', 'nativeSQLClipboardMatchesEditedQuery', 'nativeExactBigintDecimalAndUnicode', 'hiddenWindowRetainedConnectionDraftAndResult', 'nativeActiveProfileMutationRefused', 'temporaryPasswordSurvivedWindowHideAndReconnect', 'nativeDatabaseThemeLanguageAndNarrowLayout']:
            assert report[key], key
        assert report['sharedComponentEventsReachSettingsAndWorkbench']
        assert len(report['nativeDatabaseCaptures']) == 4
        direct = report['databaseDirectWorkbenchProof']
        assert all(direct[key] is True for key in ['fullMainPane', 'catalogHiddenAfterSidebarSelection', 'actualManagementButton', 'sameWorkbenchAfterManagement'])
        assert direct['capture'] == 'native-database-retained-connection-manager.png'
        assert direct['capture'] in report['nativeDatabaseCaptures']
        selection = report['databaseSidebarSelectionProof']
        assert selection['actualAppKitRow'] is True and selection['selectedTarget'] is True
        assert selection['capture'] == 'native-database-sidebar-profile-en-dark.png'
        assert selection['capture'] in report['nativeDatabaseCaptures']
        for name in report['nativeDatabaseCaptures']:
            assert (evidence / name).is_file(), name
        report.update(passed=True, testedMergeSHA=report['sourceSHA'], sourceTreeDirty=bool(subprocess.check_output(['git', 'status', '--porcelain'])), processExitCode=code,
                      postgresVersion=subprocess.check_output([str(binary / 'postgres'), '--version'], text=True).strip(),
                      postgresBinarySHA256=hashlib.sha256((binary / 'postgres').read_bytes()).hexdigest(),
                      jdbcSHA256=artifact['sha256'], jdbcVersion=artifact['version'])
        assert not report['sourceTreeDirty']
        assert report['sourceHeadSHA'] == os.environ.get('PR_HEAD_SHA', report['sourceHeadSHA'])
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    finally:
        try:
            if process is not None and process.poll() is None:
                process.kill(); process.wait(timeout=10)
            if (data / 'postmaster.pid').exists():
                subprocess.run([str(binary / 'pg_ctl'), '-D', str(data), '-w', '-t', '15', '-m', 'immediate', 'stop'], check=True)
        finally:
            leaked = []
            for file in evidence.iterdir():
                if file.suffix in ('.log', '.json', '.txt'):
                    content = file.read_bytes()
                    if password.encode() in content:
                        leaked.append(file.name)
                        file.write_bytes(content.replace(password.encode(), b'<REDACTED_QA_SECRET>'))
            assert not leaked, 'Temporary database credential appeared in evidence: ' + ', '.join(leaked)
    print('Native PostgreSQL workbench passed; source-bound report and WindowServer images saved.')
PY
