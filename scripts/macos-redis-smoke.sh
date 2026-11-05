#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
native_redis_prefix="$(brew --prefix redis)"
if [ ! -x "$native_redis_prefix/bin/redis-server" ]; then
  HOMEBREW_NO_AUTO_UPDATE=1 brew install redis
fi
export UTERM_QA_REDIS_SERVER="$native_redis_prefix/bin/redis-server"
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" <<'PY'
import hashlib, json, os, secrets, socket, subprocess, sys, tempfile, time
from pathlib import Path
app, evidence = map(Path, sys.argv[1:])
evidence.mkdir(parents=True, exist_ok=True)
binary = Path(os.environ['UTERM_QA_REDIS_SERVER'])
report_path = evidence / 'redis-live.json'
report_path.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-redis-') as directory:
    root = Path(directory)
    password = secrets.token_hex(24)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
    config = root / 'redis.conf'
    config.write_text(f'bind 127.0.0.1\nport {port}\nsave ""\nappendonly no\nrequirepass {password}\ndir "{root}"\n')
    config.chmod(0o600)
    process = None
    server = None
    def command(*values):
        def send(stream, values):
            values = [value if isinstance(value, bytes) else str(value).encode() for value in values]
            stream.sendall(b'*' + str(len(values)).encode() + b'\r\n' + b''.join(b'$' + str(len(value)).encode() + b'\r\n' + value + b'\r\n' for value in values))
        def read(stream):
            line = stream.readline()
            assert line.endswith(b'\r\n'), 'Incomplete Redis fixture response'
            if line.startswith(b'-'): raise AssertionError('Redis fixture rejected a command')
            if line.startswith(b'$'):
                length = int(line[1:-2])
                if length == -1: return None
                data = stream.read(length + 2)
                assert len(data) == length + 2 and data.endswith(b'\r\n')
                return data[:-2]
            return line[1:-2]
        with socket.create_connection(('127.0.0.1', port), timeout=5) as connection:
            stream = connection.makefile('rb')
            send(connection, ['AUTH', password]); assert read(stream) == b'OK'
            send(connection, values); return read(stream)
    try:
        with (evidence / 'redis-server.log').open('w') as log:
            server = subprocess.Popen([str(binary), str(config)], stdout=log, stderr=subprocess.STDOUT)
        for _ in range(100):
            assert server.poll() is None, 'Isolated Redis exited during startup'
            try:
                if command('PING') == b'PONG': break
            except OSError: time.sleep(0.05)
        else: raise AssertionError('Isolated Redis startup timed out')
        assert command('SET', 'native:中文', '9223372036854775807 中文🚀', 'EX', '3600') == b'OK'
        assert command('SET', b'\x00\xffkey', b'\xff\x00\x7f') == b'OK'
        application_env = dict(os.environ, UTERM_NATIVE_REDIS_PASSWORD=password, UTERM_NATIVE_REDIS_PORT=str(port))
        with (evidence / 'redis-stdout.log').open('w') as out, (evidence / 'redis-stderr.log').open('w') as err:
            process = subprocess.Popen([str(app / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', str(root), '--redis-smoke-report', str(report_path)], env=application_env, stdout=out, stderr=err)
            code = process.wait(timeout=180)
        assert code == 0, code
        report = json.loads(report_path.read_text())
        assert 'failure' not in report, report.get('failure')
        assert 'cleanupError' not in report, report.get('cleanupError')
        assert report['coreReady'] and not report['productionDataAccess']
        for key in ['nativeRedisProfileSaveWithoutPasswordPersistence', 'nativeRedisRealConnectionDefaultsReadonly', 'nativeRedisBinaryIdentityAndReadonlyPreview', 'nativeRedisHiddenWindowRetainsDraftAndConnection', 'nativeRedisWritePreservesExactTextTTLAndBinarySibling', 'nativeRedisThemeLanguageAndNarrowLayout', 'nativeRedisTemporaryPasswordSurvivesReconnect']:
            assert report[key], key
        assert command('GET', 'native:中文') == 'NATIVE_REDIS_SAVED_9223372036854775807 中文🚀'.encode()
        assert int(command('PTTL', 'native:中文')) > 0
        assert command('GET', b'\x00\xffkey') == b'\xff\x00\x7f'
        assert len(report['nativeRedisCaptures']) == 3
        for name in report['nativeRedisCaptures']:
            assert (evidence / name).is_file(), name
        report.update(passed=True, testedMergeSHA=report['sourceSHA'], sourceTreeDirty=bool(subprocess.check_output(['git', 'status', '--porcelain'])), processExitCode=code,
                      redisVersion=subprocess.check_output([str(binary), '--version'], text=True).strip(),
                      redisBinarySHA256=hashlib.sha256(binary.read_bytes()).hexdigest(), realRedisDataVerifiedAfterAppExit=True)
        assert not report['sourceTreeDirty']
        assert report['sourceHeadSHA'] == os.environ.get('PR_HEAD_SHA', report['sourceHeadSHA'])
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    finally:
        try:
            if process is not None and process.poll() is None:
                process.kill(); process.wait(timeout=10)
            if server is not None and server.poll() is None:
                server.terminate()
                try: server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill(); server.wait(timeout=10)
        finally:
            leaked = []
            for file in evidence.iterdir():
                if file.suffix in ('.log', '.json', '.txt'):
                    content = file.read_bytes()
                    if password.encode() in content:
                        leaked.append(file.name)
                        file.write_bytes(content.replace(password.encode(), b'<REDACTED_QA_SECRET>'))
            assert not leaked, 'Temporary Redis credential appeared in evidence: ' + ', '.join(leaked)
    print('Native Redis workbench passed; source-bound report and WindowServer images saved.')
PY
