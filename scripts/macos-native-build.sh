#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
swift build --package-path macos --configuration debug
native_bin=$(swift build --package-path macos --configuration debug --show-bin-path)
native_app="$PWD/macos/.build/qa/UTermNativeQA.app"
mkdir -p "$native_app/Contents/MacOS"
cp "$native_bin/UTermNativeQA" "$native_app/Contents/MacOS/UTermNativeQA"
python3 - "$native_app" "$(git rev-parse HEAD)" <<'PY'
import json, plistlib, sys
from pathlib import Path
app=Path(sys.argv[1])
minimum=json.loads(Path('src-tauri/tauri.conf.json').read_text())['bundle']['macOS']['minimumSystemVersion']
assert minimum=='14.0', 'Review the native deployment target before changing the existing minimum OS'
plist={'CFBundleIdentifier':'sh.uterm.desktop.qa.native','CFBundleName':'uTerm Native QA',
       'CFBundleDisplayName':'uTerm Native QA','CFBundleExecutable':'UTermNativeQA',
       'CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.0.1','CFBundleVersion':'1',
       'LSMinimumSystemVersion':minimum,'NSHighResolutionCapable':True,'UTermSourceSHA':sys.argv[2]}
with (app/'Contents/Info.plist').open('wb') as f: plistlib.dump(plist,f)
PY
codesign --force --sign - "$native_app"
codesign --verify --deep --strict "$native_app"
printf '%s\n' "$native_app"
