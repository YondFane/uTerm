import hashlib
import json
import os
import platform
import plistlib
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

evidence = Path('macos/.build/evidence/candidate').resolve()
evidence.mkdir(parents=True, exist_ok=True)
source = Path('macos/.build/qa/UTermNativeQA.app').resolve()
report_path = evidence / 'candidate-macos.json'
report = dict(platform='macOS', architecture=platform.machine(), system=platform.mac_ver()[0],
              productionDataAccess=False, productionDeepLinkRegistered=False,
              appleDeveloperSigned=False, notarized=False, updateSignature=False,
              diskImageSigned=False,
              candidateOnly=True, passed=False)

def run(*arguments, timeout=60):
    result = subprocess.run([str(v) for v in arguments], capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{arguments[0]} failed ({result.returncode}): ' + result.stderr.decode(errors='replace'))
    return result.stdout

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def remove_owned_tree(path):
    if not path.exists(): return
    for entry in path.rglob('*'):
        if entry.is_dir() and not entry.is_symlink(): entry.chmod(entry.stat().st_mode | stat.S_IWUSR)
    path.chmod(path.stat().st_mode | stat.S_IWUSR)
    shutil.rmtree(path)

try:
    assert platform.system() == 'Darwin'
    assert not run('git', 'status', '--porcelain').strip(), 'Candidate must use a clean source tree'
    info = plistlib.loads((source / 'Contents/Info.plist').read_bytes())
    tested = run('git', 'rev-parse', 'HEAD').decode().strip()
    head = os.environ.get('PR_HEAD_SHA', tested)
    assert info['CFBundleIdentifier'] == 'sh.uterm.desktop.qa.native'
    assert info['UTermSourceSHA'] == tested and info['UTermSourceHeadSHA'] == head
    assert not info.get('CFBundleURLTypes')
    assert info['LSMinimumSystemVersion'] == '14.0'
    report.update(sourceHeadSHA=head, testedMergeSHA=tested, sourceTreeDirty=False,
                  bundleIdentifier=info['CFBundleIdentifier'], version=info['CFBundleShortVersionString'],
                  minimumOS=info['LSMinimumSystemVersion'], codeSigning='ad-hoc; no Apple Developer identity')
    report['toolchain'] = dict(swift=run('xcrun', 'swift', '--version').decode().strip(),
                               rust=run('rustc', '--version').decode().strip(), xcode=run('xcodebuild', '-version').decode().strip())
    with tempfile.TemporaryDirectory(prefix='uterm-native-qa-candidate-') as folder:
        root = Path(folder).resolve(); stage = root / 'image'; stage.mkdir()
        staged = stage / source.name
        run('ditto', source, staged)
        resources = staged / 'Contents/Resources'
        content = resources / 'content'
        manifest = json.loads((content / 'content-manifest.json').read_text())
        assert 'native-content.html' in manifest and len(manifest) > 1
        for relative in manifest:
            target = (content / relative).resolve()
            assert target.is_relative_to(content) and target.is_file() and not target.is_symlink()
        assert (resources / 'Licenses/SwiftTerm.txt').is_file()
        assert (resources / 'Licenses/Sparkle.txt').is_file()
        assert (resources / 'Licenses/NOTICE.txt').is_file()
        report.update(webResourceEntries=len(manifest), bundledLicensesPresent=True)
        for entry in [*resources.rglob('*'), resources]:
            assert not entry.is_symlink(), 'Candidate resources cannot link outside the app'
            entry.chmod(stat.S_IMODE(entry.stat().st_mode) & ~0o222)
        executable = staged / 'Contents/MacOS/UTermNativeQA'
        executable.chmod(stat.S_IMODE(executable.stat().st_mode) & ~0o222)
        framework = staged / 'Contents/Frameworks/Sparkle.framework'
        assert framework.is_dir(), 'Sparkle runtime framework is missing'
        framework_binaries = []
        for entry in framework.rglob('*'):
            if entry.is_symlink():
                assert entry.resolve().is_relative_to(framework.resolve()), 'Framework symlink escapes the bundle'
                continue
            if entry.is_file():
                with entry.open('rb') as stream: magic = stream.read(4)
                if magic in [bytes.fromhex(value) for value in ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']]:
                    arches = run('lipo', '-archs', entry).decode().strip().split()
                    assert platform.machine() in arches, f'Sparkle helper lacks {platform.machine()}: {entry.name}'
                    run('codesign', '--verify', '--strict', entry)
                    build = run('vtool', '-arch', platform.machine(), '-show-build', entry).decode()
                    minimum = re.findall(r'\b(?:minos|version)\s+(\d+(?:\.\d+)+)', build)
                    assert minimum and tuple(map(int, minimum[0].split('.'))) <= (14, 0, 0), 'Sparkle binary raises the minimum OS'
                    dependencies = run('otool', '-L', entry).decode()
                    assert '/Users/runner/work/' not in dependencies and '/workspace/' not in dependencies
                    framework_binaries.append({'path': str(entry.relative_to(staged)), 'architectures': arches, 'minimumOS': minimum[0]})
            entry.chmod(stat.S_IMODE(entry.stat().st_mode) & ~0o222)
        framework.chmod(stat.S_IMODE(framework.stat().st_mode) & ~0o222)
        assert framework_binaries, 'No signed Sparkle runtime binaries found'
        report.update(sparkleFrameworkBinaries=framework_binaries, sparkleVersion='2.10.1', sparkleSigning='vendor framework signatures; application remains ad-hoc')
        run('codesign', '--verify', '--deep', '--strict', staged)
        architectures = {}; minimums = {}
        for name, relative in [('app', 'Contents/MacOS/UTermNativeQA'), ('helper', 'Contents/Resources/bin/utermd-local')]:
            binary = staged / relative
            architectures[name] = run('lipo', '-archs', binary).decode().strip()
            assert architectures[name] == platform.machine()
            assert os.access(binary, os.X_OK)
            run('codesign', '--verify', '--strict', binary)
            signing = subprocess.run(['codesign', '--display', '--verbose=4', str(binary)], capture_output=True, check=True).stderr
            (evidence / f'{name}-codesign.txt').write_bytes(signing)
            assert b'Signature=adhoc' in signing and b'Authority=Developer ID' not in signing
            build = run('vtool', '-show-build', binary).decode()
            (evidence / f'{name}-build-version.txt').write_text(build)
            values = re.findall(r'\b(?:minos|version)\s+(\d+(?:\.\d+)+)', build)
            assert values, 'Missing Mach-O minimum OS'
            minimums[name] = values[0]
            assert tuple(map(int, values[0].split('.'))) <= (14, 0, 0)
            dependencies = run('otool', '-L', binary).decode()
            assert '/Users/runner/work/' not in dependencies and '/workspace/' not in dependencies
            (evidence / f'{name}-dependencies.txt').write_text(dependencies)
        report.update(binaryArchitectures=architectures, binaryMinimumOS=minimums)
        name = f'UTermNativeQA-{info["CFBundleShortVersionString"]}-{platform.machine()}-{head[:12]}'
        archive = evidence / (name + '.zip'); archive.unlink(missing_ok=True)
        run('ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', staged, archive)
        image = evidence / (name + '.dmg'); image.unlink(missing_ok=True)
        run('hdiutil', 'create', '-volname', 'uTerm Native QA Candidate', '-srcfolder', stage, '-format', 'UDZO', image)
        run('hdiutil', 'verify', image)
        mount = root / 'mount'; mount.mkdir()
        installed = root / 'Private Applications' / source.name
        attached = False
        try:
            attachment = plistlib.loads(run('hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, '-plist', image))
            attached = True
            assert any(entity.get('mount-point') == str(mount) for entity in attachment['system-entities'])
            assert os.statvfs(mount).f_flag & os.ST_RDONLY
            report['imageMountedReadOnly'] = True
            installed.parent.mkdir(); run('ditto', mount / source.name, installed)
            run('codesign', '--verify', '--deep', '--strict', installed)
            installed_resources = installed / 'Contents/Resources'
            installed_framework = installed / 'Contents/Frameworks/Sparkle.framework'
            assert all(stat.S_IMODE(p.stat().st_mode) & 0o222 == 0 for p in [*installed_framework.rglob('*'), installed_framework] if not p.is_symlink())
            assert all(stat.S_IMODE(p.stat().st_mode) & 0o222 == 0 for p in [*installed_resources.rglob('*'), installed_resources])
            probe = installed_resources / 'candidate-write-probe'
            try: probe.write_bytes(b'probe')
            except PermissionError: report['runtimeResourcesWriteRejected'] = True
            else: probe.unlink(); raise AssertionError('Installed resources were writable')
            smoke = evidence / 'candidate-installed-native-smoke.json'; smoke.unlink(missing_ok=True)
            with (evidence / 'installed-stdout.log').open('w') as out, (evidence / 'installed-stderr.log').open('w') as err:
                process = subprocess.Popen([str(installed / 'Contents/MacOS/UTermNativeQA'), '--qa-data-root', str(root), '--candidate-smoke-report', str(smoke)], stdout=out, stderr=err)
                try: code = process.wait(timeout=40)
                finally:
                    if process.poll() is None: process.kill(); process.wait()
            result = json.loads(smoke.read_text())
            assert code == 0 and 'failure' not in result and 'cleanupError' not in result
            assert result['sourceHeadSHA'] == head and result['sourceSHA'] == tested
            assert result['coreReady'] and result['windowVisible'] and result['screenCount'] > 0
            assert not result['productionDataAccess'] and result['installedHelperPTYAndUnicodeOutput'] and result['explicitFixtureCloseAndIdleHostShutdown']
            assert result['helperPath'] == str(installed_resources / 'bin/utermd-local')
            original_capture = evidence / 'candidate-installed-native-window.png'
            assert original_capture.stat().st_size > 1000
            report.update(installedStartPassed=True, processExitCode=code, installedPath=str(installed),
                          screenshot='candidate-installed-native-window.png', installationScope='temporary private Applications directory')
            remove_owned_tree(installed)
            assert not installed.exists()
            assert (root / 'shared-state-v1/snapshot-v1.json').is_file()
            report.update(uninstalledAppRemoved=True, privateDataRetainedUntilFixtureCleanup=True)
        finally:
            if attached: run('hdiutil', 'detach', mount)
            remove_owned_tree(stage)
        report['artifacts'] = [dict(file=p.name, sha256=digest(p), bytes=p.stat().st_size) for p in [image, archive]]
        (evidence / 'SHA256SUMS').write_text(''.join(f'{value["sha256"]}  {value["file"]}\n' for value in report['artifacts']))
        report['passed'] = True
except Exception as error:
    report['failure'] = str(error)
    raise
finally:
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))
