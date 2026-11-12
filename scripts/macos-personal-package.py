import argparse
import base64
import hashlib
import http.server
import json
import math
import os
import platform
import plistlib
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

from ui_parity_github import validate_pr
from macos_disk_image import create_disk_image, verify_disk_image
from macos_qa_http import LoopbackHTTPServer

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
    assert info["UTermSourceHeadSHA"] == head and info["UTermSourceSHA"] == tested
    assert re.fullmatch(r"\d+\.\d+\.\d+", info["CFBundleShortVersionString"])
    assert info["LSMinimumSystemVersion"] == "14.0"
    assert not any(key.startswith(("UTermQA", "UTermPersonalQA")) for key in info)
    assert "SUFeedURL" not in info and "CFBundleURLTypes" not in info
    assert all(info.get(key) is False for key in ["SUEnableAutomaticChecks", "SUAutomaticallyUpdate"])
    if info["UTermUpdateMode"] == "automatic":
        repository = os.environ.get("GITHUB_REPOSITORY", "YondFane/uTerm")
        assert re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9_.-]+", repository)
        assert info.get("UTermUpdateFeedURL") in [f"https://github.com/{repository}/releases/download/uTerm-updates/personal-stable-{arch}.xml" for arch in ["arm64", "x86_64"]]
        key = base64.b64decode(info.get("SUPublicEDKey", ""), validate=True)
        assert len(key) == 32 and base64.b64encode(key).decode() == info["SUPublicEDKey"]
        assert info.get("UTermUpdateChannel") == "stable" and info.get("SUAllowsAutomaticUpdates") is True
        assert info.get("SUVerifyUpdateBeforeExtraction") is True
        assert info.get("CFBundleVersion") == info["CFBundleShortVersionString"]
    else:
        assert info["UTermUpdateMode"] == "manual" and info.get("SUAllowsAutomaticUpdates") is False
        assert not any(key in info for key in ["UTermUpdateFeedURL", "SUPublicEDKey"])



def validate_workspace_scenes(report, head, tested, phase):
    project = report.get("nativeProjectMenuRevisionAndWorkspaceMove", {})
    for key in ["passed", "actualMenuActions", "stalePinRejected", "staleMoveRejected", "peerSettingRetained", "terminalGenerationsAndViewsRetained", "splitLayoutRetainedInReopenedSnapshot", "movedAndReturned"]:
        assert project.get(key) is True, key
    drag = project.get("dragSimulation", {})
    for key in ["passed", "actualNSTableViewCallbacks", "ownedPasteboard", "foreignSourceRejected", "forgedPayloadRejected", "cancelledDragRejected", "staleRevisionRejected", "freshDropAndReverseVerified"]:
        assert drag.get(key) is True, key
    assert project.get("sourceHeadSHA") == head and project.get("testedMergeSHA") == tested
    assert project.get("platform") == "macOS" and project.get("architecture") in ["arm64", "x86_64"]
    assert project.get("system") and project.get("screenshot") == f"personal-{phase}-project-workspace-move.png"
    assert project["screenshot"] in report.get("captures", [])
    assert report.get("nativeProjectMenuPinCollapseOrderAndConflictVerified") is True
    assert report.get("nativeSidebarSectionOrderAndReadOnlyCollapse") is True
    assert report.get("backgroundTabCloseRetainedSelectedGeneration") is True
    scenes = report.get("workspaceScenes", [])
    expected = {(language, appearance, width) for language in ["en", "zh-Hans"]
                for appearance in ["dark", "light"] for width in [1100, 640]}
    assert len(scenes) == len(expected)
    observed = set()
    for scene in scenes:
        branch = scene.get("branchPicker", {})
        assert branch.get("actualAppKitControl") is True and branch.get("name")
        assert abs(branch.get("fontSize", 0) - 11) < 0.01 and abs(branch.get("captionGap", -100) - 5) < 1
        assert branch.get("width", 0) >= 24 and branch.get("height", 0) > 20 and branch.get("fontName")
        controls = scene.get("windowControls", [])
        assert len(controls) == 3 and abs(controls[0].get("x", -100) - 16) < 1
        assert all(control.get("width", 0) > 0 and control.get("height", 0) > 0 and 0 <= control.get("y", -100) < 44 for control in controls)
        identity = (scene["language"], scene["appearance"], scene["width"])
        assert identity in expected and identity not in observed
        observed.add(identity)
        name = f"personal-{phase}-workspace-{identity[0]}-{identity[1]}-{identity[2]}.png"
        assert scene["screenshot"] == name and name in report["captures"]
        assert scene["sourceHeadSHA"] == head and scene["testedMergeSHA"] == tested
        assert scene["platform"] == "macOS" and scene["architecture"] in ["arm64", "x86_64"]
        assert scene["system"] and scene["height"] == 720
        assert scene["scenario"] == "toolbar-sidebar-two-sessions-files"
        assert scene["filesReadable"] is True
        assert scene.get("fileGitStates") == {"note.txt": "untracked", "README.md": "untracked"}, "Missing actual file Git states"
    assert observed == expected


def validate_embedded_workspace(report, head, tested, phase):
    proof = report.get("embeddedWorkspaceFiles", {})
    for key in ["passed", "tabControlsActivated", "arrowNavigationActivated", "sameMainWindow", "orderedAndReused", "exactUnsavedDraftRetained", "cancelCloseRetainedTabs", "discardPreservedSiblingAndExternalWriter", "terminalViewAndGenerationRetained", "fontShortcutsTargetEditor", "findShortcutRetainsEditorAndTerminal"]:
        assert proof.get(key) is True, "Missing actual embedded workspace operation: " + key
    assert proof.get("sourceHeadSHA") == head and proof.get("testedMergeSHA") == tested
    assert proof.get("platform") == "macOS" and proof.get("architecture") in ["arm64", "x86_64"]
    assert proof.get("system") and proof.get("width", 0) >= 640 and proof.get("height", 0) >= 420
    assert proof.get("screenshot") == f"personal-{phase}-embedded-files.png" and proof["screenshot"] in report["captures"]


def validate_terminal_controls(report, head, tested, phase):
    proof = report.get("nativeTerminalControls", {})
    for key in ["passed", "actualFontButtonsAppliedAndRestored", "fontWritesRemainAvailableDuringFileRefresh", "fontBoundsDisabled", "unicodeCaseCountsAndNavigation", "keyboardOpenAndEscape", "keyboardShiftFindRoutesProjectSearch", "searchInputDidNotReachPTY", "terminalIdentityAndGenerationRetained", "explicitRestartRetainedDescriptorAndView"]:
        assert proof.get(key) is True, "Missing actual terminal control operation: " + key
    assert proof.get("sourceHeadSHA") == head and proof.get("testedMergeSHA") == tested
    assert proof.get("platform") == "macOS" and proof.get("architecture") in ["arm64", "x86_64"]
    assert proof.get("system") and proof.get("width", 0) >= 640 and proof.get("height", 0) >= 420
    assert proof.get("screenshot") == f"personal-{phase}-terminal-search.png" and proof["screenshot"] in report["captures"]
    assert isinstance(proof.get("generationBeforeRestart"), str) and proof["generationBeforeRestart"]
    assert isinstance(proof.get("restartedGeneration"), str) and proof["restartedGeneration"] and proof["restartedGeneration"] != proof["generationBeforeRestart"]
    assert type(proof.get("searchInputBytesBefore")) is int and proof["searchInputBytesBefore"] >= 0
    assert proof["searchInputBytesBefore"] == proof.get("searchInputBytesAfter")


def validate_sidebar_close(report, head, tested, phase):
    proof = report.get("nativeSidebarSessionClose", {})
    for key in ["passed", "actualKeyboardFocusVisible", "actualSpaceClosedBackgroundSession", "selectedGenerationRetained"]:
        assert proof.get(key) is True, "Missing actual sidebar close operation: " + key
    assert proof.get("sourceHeadSHA") == head and proof.get("testedMergeSHA") == tested
    assert proof.get("platform") == "macOS" and proof.get("architecture") in ["arm64", "x86_64"] and proof.get("system")
    assert proof.get("targetSessionID") and proof.get("selectedSessionID") and proof["targetSessionID"] != proof["selectedSessionID"]
    assert proof.get("screenshot") == f"personal-{phase}-sidebar-close-background.png" and proof["screenshot"] in report["captures"]
    assert proof.get("width", 0) >= 640 and proof.get("height", 0) >= 420


def validate_smoke_report(report, head, tested, phase):
    assert report.get("inProgress", False) is False, "An unfinished phase cannot satisfy acceptance"
    assert report["passed"] and report["explicitCloseAndIdleHostShutdown"], report
    validate_workspace_scenes(report, head, tested, phase)
    validate_settings_scenes(report, head, tested, phase)
    validate_embedded_workspace(report, head, tested, phase)
    validate_terminal_controls(report, head, tested, phase)
    validate_sidebar_close(report, head, tested, phase)
    validate_pdf_scenes(report, head, tested, phase)
    validate_quick_scenes(report, head, tested, phase)
    validate_github_scenes(report, head, tested, phase)
    assert report.get("automaticOptInAndOutVerified") if report.get("updateMode") == "automatic" else report.get("automaticOptInCannotStartUpdater")
    if report.get("updateMode") == "automatic" and phase == "initial":
        assert report["localizedUpdateStatuses"] == {"en": "You’re up to date.", "zh-Hans": "当前已是最新版本。"}
    assert report["sourceHeadSHA"] == head and report["testedMergeSHA"] == tested
    assert report["settingsWindowAppearances"] == {"en-dark": "NSAppearanceNameDarkAqua", "zh-Hans-light": "NSAppearanceNameAqua"}
    if phase == "replacement":
        assert report["profileRetainedAfterAppReplacement"]


def validate_pdf_scenes(report, head, tested, phase):
    fixture = json.loads((Path(__file__).resolve().parents[1] / "shared/fixtures/client-ui-parity.json").read_text())
    expected = {(scene["language"], scene["appearance"], scene["width"], scene["height"]) for scene in fixture["contentScenes"]}
    scenes = report.get("contentScenes", [])
    assert len(scenes) == len(expected), "Incomplete PDF screenshot grid"
    assert report.get("pdfHighlightsNativeDrawDeleteReopenAndScopeVerified") is True
    assert report.get("pdfMarkWrongRootAndPathRejected") is True
    if phase == "replacement": assert report.get("pdfHighlightsRetainedAfterReplacement") is True
    seen = set()
    for scene in scenes:
        identity = (scene["language"], scene["appearance"], scene["width"], scene["height"])
        assert identity in expected and identity not in seen, "Missing or duplicate PDF scene"
        seen.add(identity)
        assert scene.get("sourceHeadSHA") == head and scene.get("testedMergeSHA") == tested
        assert scene.get("platform") == "macOS" and scene.get("architecture") in ["arm64", "x86_64"] and scene.get("system")
        assert scene.get("scenario") == "pdf-highlights"
        assert scene.get("pdfSHA256") == fixture["pdf"]["sha256"] and scene.get("markID") == fixture["pdf"]["mark"]["id"]
        assert scene.get("marksCount") == 1
        assert scene.get("fixtureSessionCount") == 1 and scene.get("filesFolderExpanded") is True
        for key in ["actualRemoveButton", "reopenedRestoredMarks", "originalPdfUnchanged", "inMainWorkspace", "settingsPreserveDocument", "nativePointerDrawAndDelete"]:
            assert scene.get(key) is True, "Unverified PDF operation: " + key
        name = f"personal-{phase}-pdf-highlights-{identity[0]}-{identity[1]}-{identity[2]}.png"
        assert scene.get("screenshot") == name and name in report["captures"]


def validate_quick_scenes(report, head, tested, phase):
    fixture = json.loads((Path(__file__).resolve().parents[1] / "shared/fixtures/client-ui-parity.json").read_text())
    expected = {(scene["language"], scene["appearance"], scene["width"], scene["height"]) for scene in fixture["quickScenes"]}
    scenes = report.get("quickSSHScenes", [])
    assert len(scenes) == len(expected), "Incomplete Quick SSH screenshot grid"
    seen = set()
    for scene in scenes:
        identity = (scene["language"], scene["appearance"], scene["width"], scene["height"])
        assert identity in expected and identity not in seen, "Missing or duplicate Quick SSH scene"
        seen.add(identity)
        assert scene.get("sourceHeadSHA") == head and scene.get("testedMergeSHA") == tested
        assert scene.get("platform") == "macOS" and scene.get("architecture") in ["arm64", "x86_64"] and scene.get("system")
        assert scene.get("scenario") == "quick-ssh-invalid" and scene.get("inputAddress") == fixture["quickAddress"]
        assert scene.get("terminalFixtureMarker") == fixture["marker"]
        for key in ["invalidInputRejected", "addressRetained", "savedWorkspaceUnchanged", "sameMainWindow", "terminalGenerationRetained", "actualSidebarButton", "actualCancelPreservedState", "workspaceVisibleAroundDialog"]:
            assert scene.get(key) is True, "Unverified Quick SSH operation: " + key
        for key in ["modalLeft", "modalTop", "modalWidth", "modalHeight"]:
            assert type(scene.get(key)) in [int, float] and math.isfinite(scene[key]), "Missing actual Quick SSH geometry: " + key
        assert abs(scene["modalWidth"] - min(540, scene["width"] - 32)) < 1, "Quick SSH covers more than its form"
        assert 40 <= scene["modalHeight"] <= scene["height"] - 48, "Quick SSH form is clipped"
        assert abs(scene["modalLeft"] - (scene["width"] - scene["modalWidth"]) / 2) < 1 and abs(scene["modalTop"] - (scene["height"] - scene["modalHeight"]) / 2) < 1, "Quick SSH is not centered"
        name = f"personal-{phase}-quick-ssh-invalid-{identity[0]}-{identity[1]}-{identity[2]}.png"
        assert scene.get("screenshot") == name and name in report["captures"]


def validate_github_scenes(report, head, tested, phase):
    fixture = json.loads((Path(__file__).resolve().parents[1] / "shared/fixtures/client-ui-parity.json").read_text())
    expected = {(scene["language"], scene["appearance"], scene["width"], scene["height"]) for scene in fixture["githubScenes"]}
    scenes = report.get("githubPRScenes", [])
    assert len(scenes) == len(expected), "Incomplete PR screenshot grid"
    seen = set()
    for scene in scenes:
        identity = (scene["language"], scene["appearance"], scene["width"], scene["height"])
        assert identity in expected and identity not in seen, "Missing or duplicate PR scene"
        seen.add(identity)
        assert scene.get("sourceHeadSHA") == head and scene.get("testedMergeSHA") == tested
        assert scene.get("platform") == "macOS" and scene.get("architecture") in ["arm64", "x86_64"] and scene.get("system")
        assert scene.get("scenario") == "github-pr-draft"
        validate_pr(scene, fixture)
        name = f"personal-{phase}-github-pr-draft-{identity[0]}-{identity[1]}-{identity[2]}.png"
        assert scene.get("screenshot") == name and name in report["captures"]


def validate_settings_scenes(report, head, tested, phase):
    fixture = json.loads((Path(__file__).resolve().parents[1] / "shared/fixtures/client-ui-parity.json").read_text())
    expected = {(section["id"], scene["language"], scene["appearance"], scene["width"], scene["height"])
                for section in fixture["settingsSections"] for scene in fixture["settingsScenes"]}
    scenes = report.get("settingsScenes", [])
    assert len(scenes) == len(expected)
    seen = set()
    for scene in scenes:
        key = (scene["section"], scene["language"], scene["appearance"], scene["width"], scene["height"])
        assert key in expected and key not in seen
        seen.add(key)
        assert scene["sourceHeadSHA"] == head and scene["testedMergeSHA"] == tested
        assert scene["draftUnchanged"] is True and scene["navigationControlActivated"] is True
        if scene["section"] == "java": assert scene.get("javaFixtureMatched") is True
        name = f"personal-{phase}-settings-{key[0]}-{key[1]}-{key[2]}-{key[3]}.png"
        assert scene["screenshot"] == name and name in report["captures"]

def audit_app(app, architecture, head, tested):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    validate_info(info, head, tested)
    if info["UTermUpdateMode"] == "automatic":
        assert info["UTermUpdateFeedURL"].endswith(f"/personal-stable-{architecture}.xml")
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
    class EmptyFeed(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            body = b'<?xml version="1.0"?><rss version="2.0"><channel><title>Personal QA</title></channel></rss>'
            self.send_response(200)
            self.send_header("Content-Type", "application/rss+xml")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = LoopbackHTTPServer(EmptyFeed)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        return run_smoke(installed, source, root, evidence, head, tested, f"http://127.0.0.1:{server.server_port}/appcast.xml")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def preserve_capture(root, evidence, name):
    assert isinstance(name, str) and Path(name).name == name and name.endswith(".png")
    image = root / name
    assert not image.is_symlink() and image.resolve().is_relative_to(root.resolve())
    assert image.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    shutil.copyfile(image, evidence / name)
    visibility = root / (name + ".visibility.json")
    if visibility.exists() or visibility.is_symlink():
        assert not visibility.is_symlink() and visibility.resolve().is_relative_to(root.resolve())
        shutil.copyfile(visibility, evidence / visibility.name)


def preserve_incomplete_smoke(root, evidence, phase, reason, head, tested):
    """Incomplete evidence never satisfies acceptance. 未完成证据不能满足验收。"""
    progress = root / f"personal-{phase}-progress.json"
    report = dict(passed=False, incomplete=True, phase=phase, failure=reason, captures=[],
                  sourceHeadSHA=head, testedMergeSHA=tested)
    if progress.exists():
        assert not progress.is_symlink() and progress.resolve().is_relative_to(root.resolve())
        report["lastProgress"] = json.loads(progress.read_text())
        shutil.copyfile(progress, evidence / progress.name)
    for image in sorted(root.glob(f"personal-{phase}-*.png")):
        preserve_capture(root, evidence, image.name)
        report["captures"].append(image.name)
    (evidence / f"personal-{phase}-incomplete.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


def sample_smoke_timeout(pid, evidence, phase):
    """Sample only the owned QA process, with a separate bounded deadline. 仅限时采样自有 QA 进程。"""
    target = evidence / f"personal-{phase}-timeout-sample.txt"
    try:
        result = subprocess.run(["sample", str(pid), "1", "-file", str(target)], timeout=5,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if result.returncode or not target.is_file():
            target.write_text(f"QA timeout sampling did not produce a report (exit {result.returncode})\n")
    except (OSError, subprocess.SubprocessError) as error:
        target.write_text("QA timeout sampling failed: " + str(error) + "\n")


def preserve_smoke_outputs(root, evidence, phase):
    """Keep raw failure evidence before acceptance checks. 在验收检查前保留原始失败证据。"""
    path = root / f"personal-{phase}.json"
    shutil.copyfile(path, evidence / path.name)
    report = json.loads(path.read_text())
    rollback = root / f"personal-{phase}-rollback.json"
    if rollback.is_file():
        shutil.copyfile(rollback, evidence / rollback.name)
    captures = []
    for name in report.get("captures", []):
        preserve_capture(root, evidence, name)
        captures.append(name)
    # A visibility rejection can occur before the caller records the attempted capture.
    # 可见性门禁可能在调用方登记本次截图前拒绝验收。
    for image in sorted(root.glob(f"personal-{phase}-*.png")):
        if image.name not in captures:
            preserve_capture(root, evidence, image.name)
    return report, captures


def run_smoke(installed, source, root, evidence, head, tested, feed):
    captures = []
    reports = []
    phase_durations = {}
    identity = "sh.uterm.desktop.qa.native.personal." + uuid.uuid4().hex
    github_root = root / "uterm-native-qa-github-parity"
    environment = dict(os.environ)
    environment.update(json.loads(run("python3", Path(__file__).with_name("ui-parity-github-fixture.py"), "--root", github_root, "--project", root / "project")))
    for key in ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]: environment.pop(key, None)
    for phase in ["initial", "replacement"]:
        info_path = installed / "Contents/Info.plist"
        info = plistlib.loads(info_path.read_bytes())
        info.update(CFBundleIdentifier=identity, UTermQADataRoot=str(root), UTermPersonalQAPhase=phase)
        if info["UTermUpdateMode"] == "automatic":
            info["UTermUpdateFeedURL"] = feed
        else:
            info.update(UTermUpdateFeedURL="https://example.invalid/never-requested.xml", SUPublicEDKey="invalid-on-purpose")
        info_path.write_bytes(plistlib.dumps(info))
        run("codesign", "--force", "--sign", "-", installed)
        with (evidence / f"personal-{phase}-stdout.log").open("wb") as out, (evidence / f"personal-{phase}-stderr.log").open("wb") as err:
            process = subprocess.Popen([str(installed / "Contents/MacOS/uTerm"), "--qa-data-root", str(root / "ignored"),
                                        "--smoke-report", str(root / "must-not-exist.json")], stdout=out, stderr=err, env=environment)
            failure = "Personal app exited without its final report"
            started = time.monotonic()
            try:
                # The full paired grid runs in each phase; all original operation assertions still apply.
                # 每个阶段都执行完整配对网格，全部原有操作断言仍须满足。
                result = process.wait(timeout=180)
            except subprocess.TimeoutExpired:
                failure = "Personal app exceeded the 180-second phase deadline"
                sample_smoke_timeout(process.pid, evidence, phase)
                raise
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                if (github_root / "github-cli.jsonl").is_file():
                    shutil.copyfile(github_root / "github-cli.jsonl", evidence / f"github-parity-cli-{phase}-simulated.jsonl")
                if (root / f"personal-{phase}.json").is_file():
                    report, phase_captures = preserve_smoke_outputs(root, evidence, phase)
                else:
                    preserve_incomplete_smoke(root, evidence, phase, failure, head, tested)
            phase_durations[phase] = time.monotonic() - started
        assert result == 0
        assert not (root / "ignored").exists() and not (root / "must-not-exist.json").exists()
        path = root / f"personal-{phase}.json"
        assert path.is_file(), "Personal app did not write its smoke report"
        validate_smoke_report(report, head, tested, phase)
        rollback = root / f"personal-{phase}-rollback.json"
        assert rollback.is_file(), "Personal rollback evidence is missing"
        reports.append(path.name)
        captures.extend(phase_captures)
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
                fixtureBundleIdentifier=identity, qaArgumentsIgnored=True, productionDataAccess=False,
                phaseDeadlineSeconds=180, phaseDurationsSeconds=phase_durations)


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
                  manualUpdates=info["UTermUpdateMode"] == "manual", updateMode=info["UTermUpdateMode"],
                  updateFeed=info.get("UTermUpdateFeedURL"), updatePublicKey=info.get("SUPublicEDKey"),
                  productionFeedChanged=False, stableCutoverAccepted=False, passed=False)
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
            report["diskImageCreation"] = []
            create_disk_image(image, dmg, "uTerm Personal", report["diskImageCreation"])
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
