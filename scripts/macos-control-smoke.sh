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
path=evidence/'control-live.json'; path.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-') as root:
    try:
        with (evidence/'control-stdout.log').open('w') as out,(evidence/'control-stderr.log').open('w') as err:
            process=subprocess.Popen([str(app/'Contents/MacOS/UTermNativeQA'),'--qa-data-root',root,'--control-smoke-report',str(path)],stdout=out,stderr=err)
            try: code=process.wait(timeout=180)
            except subprocess.TimeoutExpired:
                subprocess.run(['sample',str(process.pid),'3','-file',str(evidence/'control-timeout-sample.txt')],timeout=10,check=False)
                process.kill();process.wait();raise
        assert code==0,code
        report=json.loads(path.read_text()); assert 'failure' not in report,report
        assert report['coreReady'] and report['windowVisible'] and not report['productionDataAccess'],report
        for key in ['realStandaloneCLI','settingsGuardRejectedWrite','unicodeInputParsed','focusReopenedWindow','explicitClosePreservedPeer','disabledEndpointUnavailable']:
            assert report[key],(key,report)
        assert report['cliCreatedRealPTYs']==2 and report['sessionCountAfterClose']==0,report
        assert len(report['controlCaptures'])==2,report
        for name in report['controlCaptures']: assert (evidence/name).stat().st_size>5000,name
        assert not (Path(root)/'control-v1/endpoint.json').exists(),'Control endpoint was retained after close'
        print(json.dumps(report,ensure_ascii=False))
    finally:
        if (Path(root)/'local-daemon-v1/endpoint.json').exists():
            target=Path(os.environ.get('CARGO_TARGET_DIR',str(Path.cwd()/'crates/uterm-core/target')))
            with (evidence/'control-cleanup.log').open('w') as log:
                helper=subprocess.Popen([str(target/'debug/uterm-core-contract'),'--serve',str(Path(root)/'shared-state-v1')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
                def call(method,params=None):
                    helper.stdin.write(json.dumps({'version':1,'id':'control-cleanup','method':method,'params':params})+'\n');helper.stdin.flush()
                    reply=json.loads(helper.stdout.readline());assert 'error' not in reply,reply
                    return reply.get('result')
                try:
                    call('host.configure',{'helper':str(app/'Contents/Resources/bin/utermd-local')})
                    for session in call('host.status').get('sessions',[]):
                        call('host.close',{'id':session['spec']['id'],'generation':session['generation']})
                    call('host.shutdownIdle')
                    deadline=time.monotonic()+5
                    while (Path(root)/'local-daemon-v1/endpoint.json').exists() and time.monotonic()<deadline:time.sleep(0.05)
                    assert not (Path(root)/'local-daemon-v1/endpoint.json').exists(),'Private QA host did not stop'
                    log.write('Isolated control QA host drained.\n')
                finally:
                    helper.stdin.close()
                    try: helper.wait(timeout=10)
                    except subprocess.TimeoutExpired:helper.kill();helper.wait();raise
PY
