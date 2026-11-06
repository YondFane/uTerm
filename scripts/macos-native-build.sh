#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
pnpm build
cargo build --locked --manifest-path crates/uterm-ffi/Cargo.toml
cargo build --locked --manifest-path crates/utermd-local/Cargo.toml --bin utermd-local
native_rust_target="${CARGO_TARGET_DIR:-$PWD/crates/uterm-ffi/target}"
swift build --force-resolved-versions --package-path macos --configuration debug -Xlinker "$native_rust_target/debug/libuterm_ffi.a" -Xlinker -framework -Xlinker Security -Xlinker -framework -Xlinker SystemConfiguration -Xlinker -rpath -Xlinker '@executable_path/../Frameworks'
native_bin=$(swift build --package-path macos --configuration debug --show-bin-path)
native_app="$PWD/macos/.build/qa/UTermNativeQA.app"
mkdir -p "$native_app/Contents/MacOS"
mkdir -p "$native_app/Contents/Resources/bin" "$native_app/Contents/Resources/Licenses"
cp "$native_bin/UTermNativeQA" "$native_app/Contents/MacOS/UTermNativeQA"
cp shared/fixtures/client-performance.json "$native_app/Contents/Resources/client-performance.json"
native_sparkle=$(find macos/.build/artifacts -type d -name Sparkle.framework -print)
test -n "$native_sparkle" && test "$(printf '%s\n' "$native_sparkle" | wc -l | tr -d ' ')" = 1
mkdir -p "$native_app/Contents/Frameworks"
ditto "$native_sparkle" "$native_app/Contents/Frameworks/Sparkle.framework"
codesign --verify --deep --strict "$native_app/Contents/Frameworks/Sparkle.framework"
native_host_target="${CARGO_TARGET_DIR:-$PWD/crates/utermd-local/target}"
cp "$native_host_target/debug/utermd-local" "$native_app/Contents/Resources/bin/utermd-local"
codesign --force --sign - "$native_app/Contents/Resources/bin/utermd-local"
python3 - "$native_app/Contents/Resources/content" <<'PYCONTENT'
import json, shutil, sys
from pathlib import Path
source=Path('dist'); target=Path(sys.argv[1]); target.mkdir(parents=True,exist_ok=True)
paths=['native-content.html']+[p.relative_to(source).as_posix() for base in ['assets','pdf-assets'] for p in (source/base).rglob('*') if p.is_file()]
for name in paths:
    destination=target/name;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/name,destination)
(target/'content-manifest.json').write_text(json.dumps(sorted(paths)))
PYCONTENT
python3 - "$native_app/Contents/Resources/Licenses/frontend" <<'PYLICENSE'
import json, shutil, sys
from pathlib import Path
root=Path('node_modules/.pnpm'); target=Path(sys.argv[1]); target.mkdir(parents=True,exist_ok=True)
packages=list(root.glob('*/node_modules/*/package.json'))+list(root.glob('*/node_modules/@*/*/package.json'))
index={}
for metadata in packages:
    data=json.loads(metadata.read_text()); identity=data['name']+'@'+data['version']
    if identity in index: continue
    folder=target/identity.replace('/','_'); files=[]
    for source in metadata.parent.iterdir():
        if source.is_file() and source.name.upper().startswith(('LICENSE','NOTICE','COPYING')):
            folder.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,folder/source.name);files.append(source.name)
    if files: index[identity]=sorted(files)
(target/'index.json').write_text(json.dumps(index,indent=2,sort_keys=True))
PYLICENSE
cp LICENSE "$native_app/Contents/Resources/Licenses/uTerm.txt"
cp NOTICE "$native_app/Contents/Resources/Licenses/NOTICE.txt"
find macos/.build/checkouts -maxdepth 2 -iname 'LICENSE*' -ipath '*swiftterm*' -exec cp '{}' "$native_app/Contents/Resources/Licenses/SwiftTerm.txt" \;
test -s "$native_app/Contents/Resources/Licenses/SwiftTerm.txt"
find macos/.build/checkouts -maxdepth 2 -iname 'LICENSE*' -ipath '*sparkle*' -exec cp '{}' "$native_app/Contents/Resources/Licenses/Sparkle.txt" \;
test -s "$native_app/Contents/Resources/Licenses/Sparkle.txt"
python3 - "$native_app" "$(git rev-parse HEAD)" <<'PY'
import json, os, plistlib, sys
from pathlib import Path
app=Path(sys.argv[1])
minimum=json.loads(Path('src-tauri/tauri.conf.json').read_text())['bundle']['macOS']['minimumSystemVersion']
assert minimum=='14.0', 'Review the native deployment target before changing the existing minimum OS'
plist={'CFBundleIdentifier':'sh.uterm.desktop.qa.native','CFBundleName':'uTerm Native QA',
       'CFBundleDisplayName':'uTerm Native QA','CFBundleExecutable':'UTermNativeQA',
       'CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.0.1','CFBundleVersion':'1',
       'LSMinimumSystemVersion':minimum,'NSHighResolutionCapable':True,'UTermSourceSHA':sys.argv[2], 'UTermSourceHeadSHA':os.environ.get('PR_HEAD_SHA',sys.argv[2])}
plist.update(SUEnableAutomaticChecks=False, SUAutomaticallyUpdate=False, SUAllowsAutomaticUpdates=False)
with (app/'Contents/Info.plist').open('wb') as f: plistlib.dump(plist,f)
PY
codesign --force --sign - "$native_app"
codesign --verify --deep --strict "$native_app"
printf '%s\n' "$native_app"
