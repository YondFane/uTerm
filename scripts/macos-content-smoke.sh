#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
launchctl print "gui/$(id -u)" >/dev/null
pgrep -x WindowServer >/dev/null
python3 - "$PWD/macos/.build/qa/UTermNativeQA.app" "$PWD/macos/.build/evidence" <<'PY'
import json, subprocess, sys, tempfile
from pathlib import Path
app=Path(sys.argv[1]); evidence=Path(sys.argv[2]);evidence.mkdir(parents=True,exist_ok=True)
path=evidence/'content-live.json';path.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='uterm-native-qa-') as root:
    with (evidence/'content-stdout.log').open('w') as out,(evidence/'content-stderr.log').open('w') as err:
        process=subprocess.Popen([str(app/'Contents/MacOS/UTermNativeQA'),'--qa-data-root',root,'--content-smoke-report',str(path)],stdout=out,stderr=err)
        try: code=process.wait(timeout=120)
        except subprocess.TimeoutExpired:
            subprocess.run(['sample',str(process.pid),'3','-file',str(evidence/'content-timeout-sample.txt')],timeout=10,check=False)
            process.kill();process.wait();raise
    assert code==0,code
    report=json.loads(path.read_text());assert 'failure' not in report,report
    assert report['coreReady'] and not report['productionDataAccess'],report
    for key in ['realCodeMirrorReadonly','fontSavedByCore','wrongDocumentRejected','rootEscapeRejected','writeRejected','sandboxPreviewIsolated','pdfRendered','documentRotatedOnReload','oldDocumentRejectedAfterReload','closedThroughNativeMenu','earlyCloseSucceeded','scopedDraftsOnlySelectedRoot','draftRootRejected','draftWriteRejected','draftStoreUnaffectedByPreview']:
        assert report[key],(key,report)
    assert len(report['contentCaptures'])==3,report
    print(json.dumps(report,ensure_ascii=False))
PY
