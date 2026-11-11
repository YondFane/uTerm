#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
native_flavor="${1:-qa}"
native_configuration=debug
native_cargo_profile=dev
native_swift_flags=(--scratch-path "$PWD/macos/.build")
native_executable=UTermNativeQA
native_app="$PWD/macos/.build/qa/UTermNativeQA.app"
native_swift_root="$PWD/macos/.build"
case "$native_flavor" in
  qa) ;;
  personal)
    export MACOSX_DEPLOYMENT_TARGET=14.0
    native_configuration=release
    native_cargo_profile=release
    native_swift_root="$PWD/macos/.build/personal-build"
    native_swift_flags=(--scratch-path "$native_swift_root" -Xswiftc -DUTERM_PERSONAL)
    native_executable=uTerm
    native_app="$PWD/macos/.build/personal/uTerm Personal.app"
    ;;
  *) printf 'Usage: %s [qa|personal]\n' "$0" >&2; exit 2 ;;
esac
pnpm build
cargo build --locked --manifest-path crates/uterm-ffi/Cargo.toml --profile "$native_cargo_profile"
cargo build --locked --manifest-path crates/utermd-local/Cargo.toml --bin utermd-local --profile "$native_cargo_profile"
native_rust_target="${CARGO_TARGET_DIR:-$PWD/crates/uterm-ffi/target}"
swift build --force-resolved-versions --package-path macos --configuration "$native_configuration" "${native_swift_flags[@]}" -Xlinker "$native_rust_target/$native_configuration/libuterm_ffi.a" -Xlinker -framework -Xlinker Security -Xlinker -framework -Xlinker SystemConfiguration -Xlinker -rpath -Xlinker '@executable_path/../Frameworks'
native_bin=$(swift build --package-path macos --configuration "$native_configuration" "${native_swift_flags[@]}" --show-bin-path)
rm -rf "$native_app"
mkdir -p "$native_app/Contents/MacOS"
mkdir -p "$native_app/Contents/Resources/bin" "$native_app/Contents/Resources/Licenses"
cp "$native_bin/UTermNativeQA" "$native_app/Contents/MacOS/$native_executable"
cp shared/fixtures/client-performance.json "$native_app/Contents/Resources/client-performance.json"
cp shared/fixtures/client-ui-parity.json "$native_app/Contents/Resources/client-ui-parity.json"
mkdir -p "$native_app/Contents/Resources/Fonts"
cp src/assets/fonts/*.ttf src/assets/fonts/manifest.json "$native_app/Contents/Resources/Fonts/"
cp src/assets/fonts/LICENSE "$native_app/Contents/Resources/Licenses/Cascadia-Code-OFL.txt"
native_sparkle=$(find "$native_swift_root/artifacts" -type d -name Sparkle.framework -print)
test -n "$native_sparkle" && test "$(printf '%s\n' "$native_sparkle" | wc -l | tr -d ' ')" = 1
mkdir -p "$native_app/Contents/Frameworks"
ditto "$native_sparkle" "$native_app/Contents/Frameworks/Sparkle.framework"
codesign --verify --deep --strict "$native_app/Contents/Frameworks/Sparkle.framework"
native_host_target="${CARGO_TARGET_DIR:-$PWD/crates/utermd-local/target}"
cp "$native_host_target/$native_configuration/utermd-local" "$native_app/Contents/Resources/bin/utermd-local"
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
find "$native_swift_root/checkouts" -maxdepth 2 -iname 'LICENSE*' -ipath '*swiftterm*' -exec cp '{}' "$native_app/Contents/Resources/Licenses/SwiftTerm.txt" \;
test -s "$native_app/Contents/Resources/Licenses/SwiftTerm.txt"
find "$native_swift_root/checkouts" -maxdepth 2 -iname 'LICENSE*' -ipath '*sparkle*' -exec cp '{}' "$native_app/Contents/Resources/Licenses/Sparkle.txt" \;
test -s "$native_app/Contents/Resources/Licenses/Sparkle.txt"
native_update_config='{}'
if [ "$native_flavor" = personal ]; then
    native_update_config=$(node scripts/personal-updates.mjs config "$(uname -m)")
fi
python3 - "$native_app" "$(git rev-parse HEAD)" "$native_flavor" "$native_executable" "$native_update_config" <<'PY'
import json, os, plistlib, sys
from pathlib import Path
app=Path(sys.argv[1])
minimum=json.loads(Path('src-tauri/tauri.conf.json').read_text())['bundle']['macOS']['minimumSystemVersion']
assert minimum=='14.0', 'Review the native deployment target before changing the existing minimum OS'
plist={'CFBundleIdentifier':'sh.uterm.desktop.qa.native','CFBundleName':'uTerm Native QA',
       'CFBundleDisplayName':'uTerm Native QA','CFBundleExecutable':'UTermNativeQA',
       'CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.0.1','CFBundleVersion':'1',
       'LSMinimumSystemVersion':minimum,'NSHighResolutionCapable':True,'UTermSourceSHA':sys.argv[2], 'UTermSourceHeadSHA':os.environ.get('PR_HEAD_SHA',sys.argv[2])}
if sys.argv[3]=='personal':
    version=json.loads(Path('package.json').read_text())['version']
    plist.update(CFBundleIdentifier='sh.uterm.desktop.personal', CFBundleName='uTerm Personal',
                 CFBundleDisplayName='uTerm Personal', CFBundleExecutable=sys.argv[4],
                 CFBundleShortVersionString=version, CFBundleVersion=version,
                 CFBundleIconFile='uTerm.icns', UTermBuildFlavor='personal', UTermUpdateMode='manual')
    import shutil
    shutil.copyfile('src-tauri/icons/icon.icns',app/'Contents/Resources/uTerm.icns')
plist.update(SUEnableAutomaticChecks=False, SUAutomaticallyUpdate=False, SUAllowsAutomaticUpdates=False)
plist.update(json.loads(sys.argv[5]))
with (app/'Contents/Info.plist').open('wb') as f: plistlib.dump(plist,f)
PY
codesign --force --sign - "$native_app"
codesign --verify --deep --strict "$native_app"
printf '%s\n' "$native_app"
