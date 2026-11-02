#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
cargo build --locked --manifest-path crates/uterm-ffi/Cargo.toml
cargo build --locked --manifest-path crates/utermd-local/Cargo.toml --bin utermd-local
native_rust_target="${CARGO_TARGET_DIR:-$PWD/crates/uterm-ffi/target}"
swift build --force-resolved-versions --package-path macos --configuration debug -Xlinker "$native_rust_target/debug/libuterm_ffi.a" -Xlinker -framework -Xlinker Security -Xlinker -framework -Xlinker SystemConfiguration
native_bin=$(swift build --package-path macos --configuration debug --show-bin-path)
native_app="$PWD/macos/.build/qa/UTermNativeQA.app"
mkdir -p "$native_app/Contents/MacOS"
mkdir -p "$native_app/Contents/Resources/bin" "$native_app/Contents/Resources/Licenses"
cp "$native_bin/UTermNativeQA" "$native_app/Contents/MacOS/UTermNativeQA"
native_host_target="${CARGO_TARGET_DIR:-$PWD/crates/utermd-local/target}"
cp "$native_host_target/debug/utermd-local" "$native_app/Contents/Resources/bin/utermd-local"
codesign --force --sign - "$native_app/Contents/Resources/bin/utermd-local"
cp LICENSE "$native_app/Contents/Resources/Licenses/uTerm.txt"
cp NOTICE "$native_app/Contents/Resources/Licenses/NOTICE.txt"
find macos/.build/checkouts -maxdepth 2 -iname 'LICENSE*' -ipath '*swiftterm*' -exec cp '{}' "$native_app/Contents/Resources/Licenses/SwiftTerm.txt" \;
test -s "$native_app/Contents/Resources/Licenses/SwiftTerm.txt"
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
with (app/'Contents/Info.plist').open('wb') as f: plistlib.dump(plist,f)
PY
codesign --force --sign - "$native_app"
codesign --verify --deep --strict "$native_app"
printf '%s\n' "$native_app"
