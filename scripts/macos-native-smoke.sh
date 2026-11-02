#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
native_evidence="$PWD/macos/.build/evidence"
mkdir -p "$native_evidence"
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$native_evidence" <<'PY'
import json, subprocess, sys
from pathlib import Path
app=Path(sys.argv[1]); evidence=Path(sys.argv[2]); report=evidence/'native-smoke.json'
report.unlink(missing_ok=True)
with (evidence/'native-stdout.log').open('w') as out, (evidence/'native-stderr.log').open('w') as err:
    result=subprocess.run([str(app/'Contents/MacOS/UTermNativeQA'),'--smoke-report',str(report)],stdout=out,stderr=err,timeout=30)
assert result.returncode==0, f'Native app exit: {result.returncode}'
data=json.loads(report.read_text())
assert data['windowVisible'] and data['screenCount']>0, data
assert data['bundleIdentifier']=='sh.uterm.desktop.qa.native', data
assert data['minimumOS']=='14.0', data
assert not data['productionDataAccess'] and not data['hostStarted'], data
data['processExitCode']=result.returncode
report.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(data,ensure_ascii=False))
PY
