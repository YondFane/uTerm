#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" <<'PY'
import json, os, subprocess, sys, tempfile, time
from pathlib import Path
app=Path(sys.argv[1]); evidence=Path(sys.argv[2]); evidence.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-') as root:
    reports=[]
    try:
        for mode,name in [('--terminal-smoke-report','terminal-live'),('--terminal-reconnect-report','terminal-reconnect')]:
            path=evidence/(name+'.json');path.unlink(missing_ok=True)
            with (evidence/(name+'-stdout.log')).open('w') as out, (evidence/(name+'-stderr.log')).open('w') as err:
                process=subprocess.Popen([str(app/'Contents/MacOS/UTermNativeQA'),'--qa-data-root',root,mode,str(path)],stdout=out,stderr=err)
                try:
                    exit_code=process.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    subprocess.run(['sample',str(process.pid),'3','-file',str(evidence/(name+'-timeout-sample.txt'))],timeout=10,check=False)
                    process.kill();process.wait()
                    raise
            assert exit_code==0, (name,exit_code)
            report=json.loads(path.read_text());assert 'failure' not in report,report
            assert report['coreReady'] and report['windowVisible'] and not report['productionDataAccess'],report
            reports.append(report)
    finally:
        if (Path(root)/'local-daemon-v1/endpoint.json').exists():
            target=Path(os.environ.get('CARGO_TARGET_DIR',str(Path.cwd()/'crates/uterm-core/target')))
            executable=target/'debug/uterm-core-contract'
            with (evidence/'terminal-cleanup.log').open('w') as log:
                helper=subprocess.Popen([str(executable),'--serve',str(Path(root)/'shared-state-v1')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
                def call(method,params=None):
                    helper.stdin.write(json.dumps({'version':1,'id':'cleanup','method':method,'params':params})+'\n');helper.stdin.flush()
                    reply=json.loads(helper.stdout.readline())
                    assert 'error' not in reply,reply
                    return reply.get('result')
                try:
                    call('host.configure',{'helper':str(app/'Contents/Resources/bin/utermd-local')})
                    status=call('host.status')
                    for session in status.get('sessions',[]): call('host.close',{'id':session['spec']['id']})
                    call('host.shutdownIdle')
                    deadline=time.monotonic()+5
                    while (Path(root)/'local-daemon-v1/endpoint.json').exists() and time.monotonic()<deadline: time.sleep(0.05)
                    assert not (Path(root)/'local-daemon-v1/endpoint.json').exists(), 'QA host did not stop'
                    log.write('Isolated QA host sessions closed and idle shutdown requested.\n')
                finally:
                    helper.stdin.close()
                    try: helper.wait(timeout=10)
                    except subprocess.TimeoutExpired: helper.kill();helper.wait();raise
    first,second=reports
    for key in ['unicodeAndAnsiParsed','alternateScreenReturned','hideAndReopenRetainedOutput','viewIdentityRetained']:
        assert first[key],(key,first)
    assert first['splitSessionCount']==2 and first['runningProcessesBeforeQuit']==2,first
    assert abs(first['nativeToolbarHeight']-40)<1,first
    assert len(first['captures'])==10,first
    assert second['replayed'] and second['explicitCloseStoppedProcesses'] and second['idleHostShutdown'],second
    assert sorted(first['sessions'],key=lambda s:s['id'])==sorted(second['sessions'],key=lambda s:s['id']),reports
    print(json.dumps({'sourceSHA':first['sourceSHA'],'sessionCount':2,'generationRetained':True,'normalExitCodes':[0,0],'captures':first['captures']},ensure_ascii=False))
PY
