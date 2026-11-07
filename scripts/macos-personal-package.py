import argparse
import hashlib
import json
import os
import platform
import plistlib
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from macos_disk_image import verify_disk_image

IDENTIFIER = "sh.uterm.desktop.personal"


def run(*args, timeout=120):
    result = subprocess.run([str(value) for value in args], capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): " + result.stderr.decode(errors="replace"))
    return result.stdout


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_info(info, head, tested):
    assert info["CFBundleIdentifier"] == IDENTIFIER
    assert info["CFBundleExecutable"] == "uTerm" and info["UTermBuildFlavor"] == "personal"
    assert info["UTermUpdateMode"] == "manual"
    assert info["UTermSourceHeadSHA"] == head and info["UTermSourceSHA"] == tested
    assert re.fullmatch(r"\d+\.\d+\.\d+", info["CFBundleShortVersionString"])
    assert info["LSMinimumSystemVersion"] == "14.0"
    assert not any(key in info for key in ["UTermQADataRoot", "UTermUpdateFeedURL", "SUFeedURL", "SUPublicEDKey", "CFBundleURLTypes"])
    assert all(info.get(key) is False for key in ["SUEnableAutomaticChecks", "SUAutomaticallyUpdate", "SUAllowsAutomaticUpdates"])


def audit_app(app, architecture, head, tested):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    validate_info(info, head, tested)
    run("codesign", "--verify", "--deep", "--strict", app)
    signature = subprocess.run(
        ["codesign", "-d", "--verbose=4", str(app)], capture_output=True, check=True).stderr
    assert b"Signature=adhoc" in signature
    for binary in [app / "Contents/MacOS/uTerm", app / "Contents/Resources/bin/utermd-local"]:
        assert run("lipo", "-archs", binary).decode().strip() == architecture
        load = run("otool", "-l", binary).decode()
        minimum = re.search(r"\bminos (\d+)\.(\d+)", load)
        if minimum is None:
            minimum = re.search(r"LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version (\d+)\.(\d+)", load)
        assert minimum and tuple(map(int, minimum.groups())) <= (14, 0), "Binary raises the minimum macOS version"
    content = app / "Contents/Resources/content"
    entries = json.loads((content / "content-manifest.json").read_text())
    assert "native-content.html" in entries and len(entries) > 1
    for name in entries:
        path = (content / name).resolve()
        assert path.is_relative_to(content.resolve()) and path.is_file() and not path.is_symlink()
    for name in ["uTerm.txt", "NOTICE.txt", "SwiftTerm.txt", "Sparkle.txt", "frontend/index.json"]:
        assert (app / "Contents/Resources/Licenses" / name).is_file()
    assert (app / "Contents/Resources/uTerm.icns").is_file()
    return info


def smoke(installed, source, root, evidence, head, tested):
    captures = []
    reports = []
    identity = "sh.uterm.desktop.qa.native.personal." + uuid.uuid4().hex
    for phase in ["initial", "replacement"]:
        info_path = installed / "Contents/Info.plist"
        info = plistlib.loads(info_path.read_bytes())
        info.update(CFBundleIdentifier=identity, UTermQADataRoot=str(root), UTermPersonalQAPhase=phase,
                    UTermUpdateFeedURL="https://example.invalid/never-requested.xml", SUPublicEDKey="invalid-on-purpose")
        info_path.write_bytes(plistlib.dumps(info))
        run("codesign", "--force", "--sign", "-", installed)
        with (evidence / f"personal-{phase}-stdout.log").open("wb") as out, (evidence / f"personal-{phase}-stderr.log").open("wb") as err:
            process = subprocess.Popen([str(installed / "Contents/MacOS/uTerm"), "--qa-data-root", str(root / "ignored"),
                                        "--smoke-report", str(root / "must-not-exist.json")], stdout=out, stderr=err)
            try:
                assert process.wait(timeout=90) == 0
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        assert not (root / "ignored").exists() and not (root / "must-not-exist.json").exists()
        path = root / f"personal-{phase}.json"
        report = json.loads(path.read_text())
        assert report["passed"] and report["automaticOptInCannotStartUpdater"] and report["explicitCloseAndIdleHostShutdown"], report
        assert report["sourceHeadSHA"] == head and report["testedMergeSHA"] == tested
        if phase == "replacement":
            assert report["profileRetainedAfterAppReplacement"]
        shutil.copyfile(path, evidence / path.name)
        rollback = root / f"personal-{phase}-rollback.json"
        shutil.copyfile(rollback, evidence / rollback.name)
        reports.append(path.name)
        for name in report["captures"]:
            assert Path(name).name == name and (root / name).read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
            shutil.copyfile(root / name, evidence / name)
            captures.append(name)
        endpoint = root / "local-daemon-v1/endpoint.json"
        deadline = time.monotonic() + 10
        pid = report["hostPID"]
        assert isinstance(pid, int) and pid > 0
        def alive():
            try:
                os.kill(pid, 0)
                return True
            except ProcessLookupError:
                return False
        while (endpoint.exists() or alive()) and time.monotonic() < deadline:
            time.sleep(.1)
        assert not endpoint.exists() and not alive(), "Fixture helper did not complete idle shutdown"
        if phase == "initial":
            shutil.rmtree(installed)
            run("ditto", source, installed)
    return dict(reports=reports, captures=captures, realWindow=True, manualAppReplacement=True,
                fixtureBundleIdentifier=identity, qaArgumentsIgnored=True, productionDataAccess=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, default=Path("macos/.build/personal/uTerm Personal.app"))
    parser.add_argument("--output", type=Path, default=Path("macos/.build/personal-packages"))
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    assert platform.system() == "Darwin", "Personal packaging requires macOS"
    assert not run("git", "status", "--porcelain").strip(), "Package only committed clean source"
    tested = run("git", "rev-parse", "HEAD").decode().strip()
    head = os.environ.get("PR_HEAD_SHA", tested)
    architecture = platform.machine()
    app, output = args.app.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    info = audit_app(app, architecture, head, tested)
    stem = f"uTerm-Personal-{info['CFBundleShortVersionString']}-macos-{architecture}-{head[:8]}"
    report = dict(platform="macOS", architecture=architecture, system=platform.mac_ver()[0], sourceHeadSHA=head,
                  testedMergeSHA=tested, sourceTreeDirty=False, bundleIdentifier=IDENTIFIER, version=info["CFBundleShortVersionString"],
                  buildConfiguration="release", codeSigning="ad-hoc", appleDeveloperSigned=False, notarized=False,
                  manualUpdates=True, productionFeedChanged=False, stableCutoverAccepted=False, passed=False)
    report_path = output / "personal-package.json"
    try:
        with tempfile.TemporaryDirectory(prefix="uterm-native-qa-personal-") as folder:
            root = Path(folder).resolve()
            image = root / "image"
            image.mkdir()
            staged = image / app.name
            run("ditto", app, staged)
            (image / "Applications").symlink_to("/Applications")
            archive, dmg = output / (stem + ".zip"), output / (stem + ".dmg")
            assert not archive.exists() and not dmg.exists(), "Refusing to overwrite existing packages"
            run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", staged, archive)
            run("hdiutil", "create", "-quiet", "-volname", "uTerm Personal", "-srcfolder", image, "-format", "UDZO", dmg)
            report["diskImageVerification"] = []
            verify_disk_image(dmg, report["diskImageVerification"])
            mount = root / "mount"
            mount.mkdir()
            run("hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg)
            try:
                mounted = mount / app.name
                audit_app(mounted, architecture, head, tested)
                installed = root / "Private Applications" / app.name
                run("ditto", mounted, installed)
                if args.smoke:
                    report["smoke"] = smoke(installed, mounted, root, output, head, tested)
                else:
                    report["smoke"] = {"executed": False, "reason": "Run --smoke in a macOS graphical session"}
                shutil.rmtree(installed)
            finally:
                run("hdiutil", "detach", mount)
            hashes = {path.name: digest(path) for path in [archive, dmg]}
            (output / "SHA256SUMS.txt").write_text("".join(f"{value}  {name}\n" for name, value in hashes.items()))
            report["packages"] = hashes
            assert not run("git", "status", "--porcelain").strip()
            report["passed"] = True
    except BaseException as error:
        report["failure"] = str(error)
        raise
    finally:
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
