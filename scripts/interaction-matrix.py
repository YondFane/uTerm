"""Audit source-bound native interaction evidence. 核对绑定源码的原生交互证据。"""

import json
import os
import subprocess
import sys
from pathlib import Path


def verify_source(report, head, tested):
    assert report.get("sourceHeadSHA", report.get("head")) == head, "Stale source head"
    assert report.get("testedMergeSHA", report.get("sourceSHA", report.get("tested"))) == tested, "Stale tested SHA"
    assert not report.get("sourceTreeDirty", False), "Dirty source evidence"
    assert not report.get("failure") and not report.get("cleanupErrors"), "Failed or unclean evidence"
    assert report.get("productionDataAccess") is False, "Missing production-data isolation"


def image_evidence(directory, names):
    assert names, "Missing screenshot evidence"
    for name in names:
        image = directory / name
        assert image.resolve().is_relative_to(directory.resolve()), "Screenshot escaped artifact directory"
        assert image.stat().st_size > 1000 and image.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"), f"Invalid screenshot: {name}"
    return names


def native_matrix(directory, head, tested):
    names = ["terminal-live", "terminal-reconnect", "settings-native", "inspector-native", "github-native", "editor-live", "agent-native"]
    reports = {name: json.loads((directory / (name + ".json")).read_text()) for name in names}
    captures = []
    for name, report in reports.items():
        verify_source(report, head, tested)
        assert report.get("platform") == "macOS", f"Wrong native platform: {name}"
        assert report.get("passed") is True, f"Unaccepted report: {name}"
        if name != "terminal-reconnect":
            captures.extend(image_evidence(directory, report["captures"]))
            if report.get("preferenceCaptures"):
                captures.extend(image_evidence(directory, report["preferenceCaptures"]))
    live = reports["terminal-live"]
    assert live["nativeCompositionSimulation"]["passed"] and live["nativeCompositionSimulation"]["interimPTYBytes"] == 0
    assert live["nativeCompositionSimulation"]["physicalIME"] is False
    assert live["lifecycleSimulation"]["passed"] and live["lifecycleSimulation"]["physicalSleep"] is False
    assert live["lifecycleSimulation"]["physicalMultipleDisplays"] is False
    assert live["realVim"]["passed"] and live["realVim"]["nativeClipboardPaste"]
    assert live["fullScreenEnteredAndExited"] and live["viewIdentityRetained"]
    assert reports["terminal-reconnect"]["explicitCloseStoppedProcesses"] and reports["terminal-reconnect"]["idleHostShutdown"]
    assert reports["inspector-native"]["closeFocusedToolsRetainsPTYAndReturnsFocus"]
    assert reports["settings-native"]["nativeFileTabLimitConflictRetainsDraftAndExplicitCloseAllowsRetry"]
    assert reports["github-native"]["nativeGithubHideReopenAndQuitCancelRetainDraft"]
    return {
        "platform": "macOS", "architecture": live["architecture"], "system": live["system"],
        "reports": [name + ".json" for name in names], "captures": sorted(set(captures)),
        "capabilities": {
            "focus": "native automatic controls and responder checks",
            "clipboard": "real NSPasteboard and native paste into real Vim",
            "splitAndFullscreen": "real native window/retained terminal views",
            "fileTabsAndDrafts": "native tabs and actual WK editor guards",
            "mainTUI": "real /usr/bin/vim; exact saved UTF-8 file",
            "composition": "simulated NSTextInputClient marked-text sequence; real terminal and PTY",
            "sleepWake": "simulated OS notifications; real retained PTY output",
            "displayChangeAndWindowMovement": "simulated display notification and programmatic movement; physical multiple monitors not executed",
            "sessionTabDragAndPersistentLayout": "outside accepted M3 scope; original implementation gaps remain visible in #17/#13",
        },
        "stableCutoverAccepted": False,
    }


def tauri_matrix(directory, head, tested):
    report = json.loads((directory / "report.json").read_text())
    verify_source(report, head, tested)
    assert report["passed"] and report["platform"] in ("win32", "darwin")
    scenes = report["scenes"]
    required = {"editor-saved", "preview-returned-editor", "git-worktree", "theme-imported", "input-owner-returned", "input-owner-closed", "input-viewer-owned"}
    assert required <= {scene["scenario"] for scene in scenes}, "Required real desktop scenes missing"
    for scene in scenes:
        verify_source(scene, head, tested)
        assert scene["scenario"] != "failure"
    captures = [str(Path(scene["screenshot"]).resolve().relative_to(directory.resolve())) for scene in scenes if scene.get("screenshot")]
    image_evidence(directory, captures)
    return {
        "platform": report["platform"], "architecture": report["architecture"], "system": report["system"],
        "reports": ["report.json"], "captures": captures, "sceneCount": len(scenes),
        "capabilities": {
            "filesSettingsGitAndSessionOwnership": "actual isolated desktop with DOM input, real Core/PTys and native screenshots",
            "clipboardAndComposition": "DOM clipboard input inside actual app; precise composition failure cases use platform test log",
            "mainTUI": "terminal/ANSI simulation and renderer recovery; native Vim evidence belongs only to macOS",
            "physicalIMEAndSleepAndMultipleMonitors": "not executed; final manual acceptance waived by user",
        },
        "stableCutoverAccepted": False,
    }


if __name__ == "__main__":
    mode, path = sys.argv[1:]
    directory = Path(path).resolve()
    tested = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    head = os.environ.get("PR_HEAD_SHA", tested)
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"]))
    try:
        assert mode in ("native", "tauri"), "Unknown client"
        assert not dirty, "Source tree is dirty"
        result = (native_matrix if mode == "native" else tauri_matrix)(directory, head, tested)
        result.update(passed=True)
    except Exception as error:
        result = {"passed": False, "failure": str(error), "client": mode}
    result.update(sourceHeadSHA=head, testedMergeSHA=tested, sourceTreeDirty=dirty,
                  manualAcceptance="waived by user; simulations stay explicitly labelled", productionDataAccess=False)
    (directory / "interaction-matrix.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["passed"] else 1)
