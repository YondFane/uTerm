#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" <<'PY'
import json, os, subprocess, sys, tempfile, time
from contextlib import ExitStack
from pathlib import Path
app=Path(sys.argv[1]); evidence=Path(sys.argv[2]); evidence.mkdir(parents=True,exist_ok=True)
tested=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
head=os.environ.get('PR_HEAD_SHA',tested)
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip(),'Input ownership QA requires clean source'
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-') as temporary, ExitStack() as files:
    root=Path(temporary); processes=[]
    def launch(role):
        report=evidence/('input-control-'+role+'.json'); report.unlink(missing_ok=True)
        out=files.enter_context((evidence/('input-control-'+role+'-stdout.log')).open('w'))
        err=files.enter_context((evidence/('input-control-'+role+'-stderr.log')).open('w'))
        process=subprocess.Popen([str(app/'Contents/MacOS/UTermNativeQA'),'--qa-data-root',str(root),'--input-control-report',str(report),'--input-control-role',role],stdout=out,stderr=err)
        processes.append(process)
        return process,report
    def finish(process,report):
        try: code=process.wait(timeout=100)
        except subprocess.TimeoutExpired:
            subprocess.run(['sample',str(process.pid),'3','-file',str(evidence/(report.stem+'-timeout-sample.txt'))],timeout=10,check=False)
            raise
        assert code==0,(report.name,code)
        value=json.loads(report.read_text()); assert value.get('passed') and 'failure' not in value,value
        assert value['coreReady'] and value['windowVisible'] and not value['productionDataAccess'],value
        assert not value['manualKeyboardIMEAcceptance'],value
        assert value['sourceHeadSHA']==head and value['sourceSHA']==tested,value
        assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip(),'Input ownership QA changed source'
        for name in value['captures']: assert (evidence/name).stat().st_size>5000,name
        value.update(testedMergeSHA=tested,sourceTreeDirty=False)
        report.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
        return value
    try:
        owner,owner_report=launch('owner')
        deadline=time.monotonic()+50
        while not (root/'owner-ready').exists():
            assert owner.poll() is None,'Owner exited before its actual terminal was ready'
            assert time.monotonic()<deadline,'Owner startup timed out'
            time.sleep(0.05)
        viewer,viewer_report=launch('viewer')
        second=finish(viewer,viewer_report)
        (root/'viewer-exited').write_text('ordinary exit completed\n')
        first=finish(owner,owner_report)
        assert first['hostPID']==second['hostPID'] and first['generation']==second['generation'] and first['sessionID']==second['sessionID'],(first,second)
        for key in ['passiveInputAndResizeRejected','passiveWindowDidNotResizeOrStealControl','passiveOutputContinued','ordinaryViewerQuitRetainedProcess','sameHostAndGeneration','reacquiredThroughNativeButton','explicitCloseAndHostCleanup']: assert first[key],(key,first)
        for key in ['initialReadonlyReplay','passiveInputRejected','explicitNativeButtonTakeover','sameHostAndGeneration']: assert second[key],(key,second)
        assert first['renderedFrames']>0 and second['renderedFrames']>0 and first['acknowledgedFrames']>0 and second['acknowledgedFrames']>0,(first,second)
        deadline=time.monotonic()+5
        while (root/'local-daemon-v1/endpoint.json').exists() and time.monotonic()<deadline: time.sleep(0.05)
        assert not (root/'local-daemon-v1/endpoint.json').exists(),'Isolated ownership QA host did not stop'
        print(json.dumps({'sourceHeadSHA':first['sourceHeadSHA'],'sourceSHA':first['sourceSHA'],'platform':first['platform'],'architecture':first['architecture'],'system':first['system'],'passed':True,'captures':first['captures']+second['captures']},ensure_ascii=False))
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill();process.wait()
        if (root/'local-daemon-v1/endpoint.json').exists():
            target=Path(os.environ.get('CARGO_TARGET_DIR',str(Path.cwd()/'crates/uterm-core/target')))
            with (evidence/'input-control-cleanup.log').open('w') as log:
                helper=subprocess.Popen([str(target/'debug/uterm-core-contract'),'--serve',str(root/'shared-state-v1')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
                def call(method,params=None):
                    helper.stdin.write(json.dumps({'version':1,'id':'input-control-cleanup','method':method,'params':params})+'\n');helper.stdin.flush()
                    reply=json.loads(helper.stdout.readline());assert 'error' not in reply,reply
                    return reply.get('result')
                try:
                    call('host.configure',{'helper':str(app/'Contents/Resources/bin/utermd-local')})
                    for session in call('host.status').get('sessions',[]): call('host.close',{'id':session['spec']['id'],'generation':session['generation']})
                    call('host.shutdownIdle')
                finally:
                    helper.stdin.close()
                    try: helper.wait(timeout=10)
                    except subprocess.TimeoutExpired: helper.kill();helper.wait();raise
PY
