#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" <<'PY'
import json, subprocess, sys, tempfile
from pathlib import Path
app=Path(sys.argv[1]); evidence=Path(sys.argv[2]); evidence.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-') as root:
    reports=[]
    for mode,name in [('--terminal-smoke-report','terminal-live'),('--terminal-reconnect-report','terminal-reconnect')]:
        path=evidence/(name+'.json');path.unlink(missing_ok=True)
        with (evidence/(name+'-stdout.log')).open('w') as out, (evidence/(name+'-stderr.log')).open('w') as err:
            result=subprocess.run([str(app/'Contents/MacOS/UTermNativeQA'),'--qa-data-root',root,mode,str(path)],stdout=out,stderr=err,timeout=60)
        assert result.returncode==0, (name,result.returncode)
        report=json.loads(path.read_text());assert 'failure' not in report,report
        assert report['coreReady'] and report['windowVisible'] and not report['productionDataAccess'],report
        reports.append(report)
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
