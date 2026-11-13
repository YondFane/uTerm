"""Compare source-bound real-window artifacts. 对照绑定源码的真实窗口产物。"""

from ui_parity_github import validate_pr
from ui_parity_run_panels import validate_run_panels, validate_native_run_forms

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import struct
import time
import urllib.request
from pathlib import Path


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_viewer(output, report):
    template = Path(__file__).with_name("ui-parity-viewer.html").read_text(encoding="utf-8")
    token = '"__UTERM_COMPARISON__"'
    assert template.count(token) == 1
    # JSON stays data even if source metadata contains an HTML closing tag.
    # 即使源码元数据包含 HTML 结束标签，JSON 也仅作为数据处理。
    data = json.dumps(report, ensure_ascii=False).replace("<", "\\u003c").replace("&", "\\u0026")
    (Path(output) / "comparison.html").write_text(template.replace(token, data), encoding="utf-8")


def image(root, name, minimum_height=720):
    path = root / name
    assert path.resolve().is_relative_to(root.resolve()) and not path.is_symlink(), "Image escaped artifact directory"
    data = path.read_bytes()
    assert len(data) > 1000 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR", "Missing real-window PNG"
    width, height = struct.unpack(">II", data[16:24])
    assert 640 <= width <= 10000 and minimum_height <= height <= 10000, "Screenshot is too small or invalid"
    return path, hashlib.sha256(data).hexdigest()


def compare(native_path, tauri_path, output, head, tested, fixture_path):
    assert re.fullmatch(r"[0-9a-f]{40}", head) and re.fullmatch(r"[0-9a-f]{40}", tested)
    native_path, tauri_path, output = Path(native_path), Path(tauri_path), Path(output)
    native, tauri = read_json(native_path), read_json(tauri_path)
    fixture = read_json(fixture_path)
    fixture_digest = hashlib.sha256(Path(fixture_path).read_bytes()).hexdigest()
    chrome_path = Path(fixture_path).parent.parent / "contracts/chrome-ui-v1.json"
    chrome_digest = hashlib.sha256(chrome_path.read_bytes()).hexdigest()
    chrome = read_json(chrome_path)
    fonts = read_json(chrome_path.parents[2] / "src/assets/fonts/manifest.json")
    font_digest = fonts["files"]["CascadiaCode-Regular.ttf"]
    for report, source, merge in [(native, "sourceHeadSHA", "testedMergeSHA"), (tauri, "head", "tested")]:
        assert report.get("passed") is True and not report.get("failure") and not report.get("cleanupErrors"), "Unaccepted application run"
        assert report.get(source) == head and report.get(merge) == tested, "Wrong source or tested merge SHA"
        assert report.get("productionDataAccess") is False and not report.get("sourceTreeDirty", False), "Unisolated or dirty run"
        assert report.get("uiParityFixtureSHA256") == fixture_digest, "Different fixture data"
    assert native["platform"] == "macOS" and tauri["platform"] == "darwin"
    assert native["architecture"] == tauri["architecture"] == "arm64", "Different capture architecture"
    assert re.search(r"\d+\.\d+(?:\.\d+)?", native["system"])[0] == tauri["productVersion"], "Different macOS version"
    restarts = [entry for entry in tauri["scenes"] if entry["scenario"] == "terminal-restart"]
    assert len(restarts) == 1, "Missing or duplicate ordinary restart evidence"
    restart = restarts[0]
    checks = restart["checks"]
    for key in ["passed", "actualRestartButton", "parsedUnicodeOutput", "canonicalWorkspaceRetained", "terminalViewRetained"]:
        assert checks.get(key) is True, "Unaccepted ordinary restart: " + key
    assert isinstance(checks.get("generationBeforeRestart"), str) and checks["generationBeforeRestart"]
    assert isinstance(checks.get("restartedGeneration"), str) and checks["restartedGeneration"] and checks["restartedGeneration"] != checks["generationBeforeRestart"]
    assert restart["screenshot"] == "ui-parity-terminal-restart.png"
    restart_file, restart_digest = image(tauri_path.parent, restart["screenshot"])
    expected = {(lang, appearance, width) for lang in fixture["languages"] for appearance in fixture["appearances"] for width in fixture["widths"]}
    native_scenes = native["workspaceScenes"]
    tauri_scenes = [entry for entry in tauri["scenes"] if entry["scenario"].startswith("workspace-")]
    assert len(native_scenes) == len(tauri_scenes) == len(expected), "Incomplete screenshot grid"
    assert native.get("backgroundTabCloseRetainedSelectedGeneration") is True, "Background close was not verified"
    def key(scene):
        return scene["language"], scene["appearance"], scene["width"]
    left = {key(scene): scene for scene in native_scenes}
    right = {key(scene["checks"]): scene for scene in tauri_scenes}
    assert set(left) == set(right) == expected, "Missing or duplicate scenes"
    pairs = []
    for identity in sorted(expected):
        language, appearance, width = identity
        n, t = left[identity], right[identity]
        expected_native = f"personal-initial-workspace-{language}-{appearance}-{width}.png"
        expected_tauri = f"ui-parity-workspace-{language}-{appearance}-{width}.png"
        assert n["screenshot"] == expected_native and t["screenshot"] == expected_tauri
        assert n["sourceHeadSHA"] == head and n["testedMergeSHA"] == tested
        assert n["height"] == t["checks"]["height"] == fixture["height"]
        for scene in [n, t["checks"]]:
            assert scene.get("fileGitStates") == {path: "untracked" for path in fixture["files"]}, "Missing actual file Git states"
        assert n.get("chromeContractSHA256") == t["checks"].get("chromeContractSHA256") == chrome_digest, "Different or stale chrome contract"
        for branch, kind in [(n.get("branchPicker", {}), "actualAppKitControl"), (t["checks"].get("branchPicker", {}), "actualDOMControl")]:
            assert branch.get(kind) is True and branch.get("name") == fixture["github"]["head"], "Missing actual branch control"
            assert abs(branch.get("fontSize", 0) - 11) < 0.01 and abs(branch.get("captionGap", -100) - 5) < 1, "Incorrect branch font or caption spacing"
            assert branch.get("width", 0) >= 24 and branch.get("height", 0) > 20 and branch.get("fontName"), "Unmeasured branch control"
        assert abs(n["branchPicker"]["height"] - t["checks"]["branchPicker"]["height"]) < 1, "Mismatched branch control heights"

        assert all(abs(scene.get("toolbarHeight", 0) - chrome["metrics"]["titlebarHeight"]) < 1 for scene in [n, t["checks"]]), "Wrong actual chrome height"
        assert all(abs(scene.get("toolbarTop", -100)) < 1 for scene in [n, t["checks"]]), "Wrong actual chrome position"
        expected_sidebar = min(chrome["metrics"]["sidebarDefaultWidth"], max(chrome["metrics"]["sidebarMinimumWide"], min(chrome["metrics"]["sidebarMaximumWidth"], width * chrome["metrics"]["sidebarMaximumRatio"])))
        assert all(abs(scene.get("sidebarWidth", 0) - expected_sidebar) < 1 for scene in [n, t["checks"]]), "Wrong actual sidebar width"
        for metric in ["sidebarRowHeight", "sidebarSectionHeight", "sidebarSectionGap", "sidebarListTop"]:
            assert all(abs(scene.get(metric, -100) - chrome["metrics"][metric]) < 1 for scene in [n, t["checks"]]), "Wrong actual sidebar geometry: " + metric
        for metric, expected_value in dict(sidebarRailLeft=0, sidebarRailWidth=chrome["metrics"]["sidebarRailWidth"],
                                           sidebarAllButtonLeft=(chrome["metrics"]["sidebarRailWidth"] - chrome["metrics"]["railButtonSize"]) / 2,
                                           sidebarAllButtonTop=chrome["metrics"]["titlebarHeight"] + 8,
                                           sidebarAllButtonWidth=chrome["metrics"]["railButtonSize"], sidebarAllButtonHeight=chrome["metrics"]["railButtonSize"]).items():
            assert all(type(scene.get(metric)) in [int, float] and abs(scene[metric] - expected_value) < 1 for scene in [n, t["checks"]]), "Clipped or missing actual sidebar navigation: " + metric
        remaining = max(chrome["metrics"]["inspectorMinimumAvailable"], width - expected_sidebar)
        expected_tools = max(chrome["metrics"]["panelCollapseWidth"], min(remaining - chrome["metrics"]["mainMinimumWidth"], remaining * chrome["metrics"]["inspectorMaximumRatio"], remaining * chrome["metrics"]["inspectorDefaultRatio"]))
        assert all(abs(scene.get("inspectorWidth", 0) - expected_tools) < 1 for scene in [n, t["checks"]]), "Wrong actual tools width"
        for metric, expected_value in dict(inspectorTop=0, inspectorHeight=fixture["height"], inspectorHeaderTop=0,
                                           inspectorFooterBottom=fixture["height"], inspectorViewportHeight=fixture["height"]).items():
            assert all(type(scene.get(metric)) in [int, float] and abs(scene[metric] - expected_value) < 1 for scene in [n, t["checks"]]), "Wrong actual tools vertical geometry: " + metric
        assert n["scenario"] == t["checks"]["scenario"] == "toolbar-sidebar-two-sessions-files"
        assert n["filesReadable"] is True and t["checks"]["filesReadable"] is True
        assert n["fontSize"] == t["checks"]["fontSize"] == fixture["fontSize"]
        for actual in [n, t["checks"]]:
            assert actual.get("fontFamily") == fonts["family"] and actual.get("fontFace") == "CascadiaCode-Regular", "Terminal used a fallback face"
            assert actual.get("fontSourceSHA256") == font_digest, "Different or stale bundled font"
            assert isinstance(actual.get("fontCharacterWidth"), (int, float)) and 1 < actual["fontCharacterWidth"] < 32, "Missing actual font measurement"
        assert abs(n["fontCharacterWidth"] - t["checks"]["fontCharacterWidth"]) < 0.1, "Different actual terminal character widths"
        for scene in [n, t["checks"]]:
            renderer = scene.get("terminalRenderer", {})
            assert all(type(renderer.get(key)) is int and 0 < renderer[key] <= 10000 for key in ["columns", "rows"]), "Missing actual terminal renderer grid"
            assert all(type(renderer.get(key)) is int and renderer[key] == renderer[actual] for key, actual in [("proposedColumns", "columns"), ("proposedRows", "rows")]), "Terminal grid has not fitted its current viewport"
            assert all(type(renderer.get(key)) in [int, float] and math.isfinite(renderer[key]) and 0 < renderer[key] <= 10000 for key in ["viewportWidth", "viewportHeight", "backingScale", "cellWidth", "cellHeight"]), "Missing actual terminal renderer viewport, scale or cell size"
        for metric in ["terminalInsetLeft", "terminalInsetRight", "terminalInsetBottom", "terminalHeaderTop", "terminalHeaderHeight", "terminalViewportGap"]:
            values = [scene.get(metric) for scene in [n, t["checks"]]]
            assert all(type(value) in [int, float] and 0 <= value < 1000 for value in values), "Missing actual terminal geometry: " + metric
            assert abs(values[0] - values[1]) < 1, "Different actual terminal geometry: " + metric
        assert abs(n["terminalViewportGap"] - 12) < 1 and n["terminalHeaderHeight"] >= 26, "Wrong terminal header or viewport gap"
        assert n["projectName"] == t["checks"]["projectName"] == fixture["projectName"]
        assert n["workspaceName"] == t["checks"]["workspaceName"] == fixture["workspaceName"]
        assert t["checks"].get("generationRetained") is True and t["checks"]["projectName"] == fixture["projectName"]
        assert expected_native in native["captures"]
        nfile, ndigest = image(native_path.parent, expected_native)
        tfile, tdigest = image(tauri_path.parent, expected_tauri)
        pairs.append(dict(language=language, appearance=appearance, width=width, height=fixture["height"],
                          area="workspace",
                          native=expected_native, tauri=expected_tauri, nativeSHA256=ndigest, tauriSHA256=tdigest,
                          terminalRenderer=dict(native=n["terminalRenderer"], tauri=t["checks"]["terminalRenderer"])))
    expected_settings = {(section["id"], scene["language"], scene["appearance"], scene["width"], scene["height"])
                         for section in fixture["settingsSections"] for scene in fixture["settingsScenes"]}
    nsettings = native.get("settingsScenes", [])
    tsettings = [entry for entry in tauri["scenes"] if entry["scenario"].startswith("settings-")]
    assert len(nsettings) == len(tsettings) == len(expected_settings), "Incomplete settings screenshot grid"
    def settings_key(scene):
        return scene["section"], scene["language"], scene["appearance"], scene["width"], scene["height"]
    left_settings = {settings_key(scene): scene for scene in nsettings}
    right_settings = {settings_key(scene["checks"]): scene for scene in tsettings}
    assert set(left_settings) == set(right_settings) == expected_settings, "Missing or duplicate settings scenes"
    for identity in sorted(expected_settings):
        section, language, appearance, width, height = identity
        n, t = left_settings[identity], right_settings[identity]
        assert n["sourceHeadSHA"] == head and n["testedMergeSHA"] == tested, "Stale settings screenshot"
        assert n["platform"] == native["platform"] and n["architecture"] == native["architecture"] and n["system"] == native["system"], "Wrong settings capture platform"
        assert all(scene.get("navigationControlActivated") is True and scene.get("draftUnchanged") is True for scene in [n, t["checks"]]), "Unverified settings navigation"
        for scene in [n, t["checks"]]:
            assert scene.get("workspaceModal") is True, "Settings is not a workspace modal"
            card = scene.get("settingsCard", {})
            assert all(type(card.get(key)) in [int, float] for key in ["x", "y", "width", "height"]), "Missing actual settings card geometry"
            assert card["width"] > 0 and card["height"] > 0 and 0 <= card["x"] < width and 0 <= card["y"] < height, "Invalid settings card geometry"
            assert card["x"] + card["width"] <= width + 1 and card["y"] + card["height"] <= height + 1, "Settings card extends outside the workspace"
        for metric in ["x", "y", "width", "height"]:
            assert abs(n["settingsCard"][metric] - t["checks"]["settingsCard"][metric]) < 1, "Different actual settings card geometry: " + metric
        assert n["automaticUpdates"] == t["checks"]["automaticUpdates"] == fixture["automaticUpdates"], "Different update preference in settings captures"
        if section == "maven":
            assert n["mavenFixtureMatched"] is True and t["checks"]["mavenFixtureMatched"] is True, "Maven controls were not checked against the fixture"
        if section == "java":
            assert n["javaFixtureMatched"] is True and t["checks"]["javaFixtureMatched"] is True, "Java component catalog was not loaded"
        if section == "database":
            assert n["databaseFixtureMatched"] is True and t["checks"]["databaseFixtureMatched"] is True, "Database component catalog was not loaded"
        name = f"settings-{section}-{language}-{appearance}-{width}"
        expected_native, expected_tauri = f"personal-initial-{name}.png", f"ui-parity-{name}.png"
        assert n["screenshot"] == expected_native and t["screenshot"] == expected_tauri and expected_native in native["captures"]
        _, ndigest = image(native_path.parent, expected_native, minimum_height=height)
        _, tdigest = image(tauri_path.parent, expected_tauri, minimum_height=height)
        pairs.append(dict(area="settings", section=section, language=language, appearance=appearance, width=width, height=height, settingsCard=n["settingsCard"],
                          native=expected_native, tauri=expected_tauri, nativeSHA256=ndigest, tauriSHA256=tdigest))
    expected_pdf = {(scene["language"], scene["appearance"], scene["width"], scene["height"]) for scene in fixture["contentScenes"]}
    npdf = native.get("contentScenes", [])
    tpdf = [entry for entry in tauri["scenes"] if entry["scenario"].startswith("pdf-highlights-")]
    assert len(npdf) == len(tpdf) == len(expected_pdf), "Incomplete PDF screenshot grid"
    assert native.get("pdfHighlightsNativeDrawDeleteReopenAndScopeVerified") is True and native.get("pdfMarkWrongRootAndPathRejected") is True, "Unverified native PDF gestures or document scope"
    def content_key(scene):
        return scene["language"], scene["appearance"], scene["width"], scene["height"]
    left_pdf = {content_key(scene): scene for scene in npdf}
    right_pdf = {content_key(scene["checks"]): scene for scene in tpdf}
    assert set(left_pdf) == set(right_pdf) == expected_pdf, "Missing or duplicate PDF scenes"
    for identity in sorted(expected_pdf):
        language, appearance, width, height = identity
        n, t = left_pdf[identity], right_pdf[identity]
        assert n.get("sourceHeadSHA") == head and n.get("testedMergeSHA") == tested, "Stale PDF screenshot"
        assert n.get("platform") == native["platform"] and n.get("architecture") == native["architecture"] and n.get("system") == native["system"], "Wrong PDF capture platform"
        assert n.get("scenario") == "pdf-highlights" and n.get("nativePointerDrawAndDelete") is True
        assert t["checks"].get("passed") is True
        for actual in [n, t["checks"]]:
            assert actual.get("pdfSHA256") == fixture["pdf"]["sha256"] and actual.get("markID") == fixture["pdf"]["mark"]["id"] and actual.get("marksCount") == 1, "Different PDF or annotations"
            assert actual.get("fixtureSessionCount") == 1 and actual.get("filesFolderExpanded") is True, "Different PDF surrounding fixture state"
            for proof in ["actualRemoveButton", "reopenedRestoredMarks", "originalPdfUnchanged", "inMainWorkspace", "settingsPreserveDocument"]:
                assert actual.get(proof) is True, "Unverified PDF operation: " + proof
        name = f"pdf-highlights-{language}-{appearance}-{width}"
        expected_native, expected_tauri = f"personal-initial-{name}.png", f"ui-parity-{name}.png"
        assert t["scenario"] == name and n["screenshot"] == expected_native and t["screenshot"] == expected_tauri and expected_native in native["captures"]
        _, ndigest = image(native_path.parent, expected_native, minimum_height=height)
        _, tdigest = image(tauri_path.parent, expected_tauri, minimum_height=height)
        pairs.append(dict(area="pdf-highlights", language=language, appearance=appearance, width=width, height=height,
                          native=expected_native, tauri=expected_tauri, nativeSHA256=ndigest, tauriSHA256=tdigest))
    expected_quick = {(scene["language"], scene["appearance"], scene["width"], scene["height"]) for scene in fixture["quickScenes"]}
    nquick = native.get("quickSSHScenes", [])
    tquick = [entry for entry in tauri["scenes"] if entry["scenario"].startswith("quick-ssh-invalid-")]
    assert len(nquick) == len(tquick) == len(expected_quick), "Incomplete Quick SSH screenshot grid"
    left_quick = {content_key(scene): scene for scene in nquick}
    right_quick = {content_key(scene["checks"]): scene for scene in tquick}
    assert set(left_quick) == set(right_quick) == expected_quick, "Missing or duplicate Quick SSH scenes"
    for identity in sorted(expected_quick):
        language, appearance, width, height = identity
        n, t = left_quick[identity], right_quick[identity]
        assert n.get("sourceHeadSHA") == head and n.get("testedMergeSHA") == tested, "Stale Quick SSH screenshot"
        assert n.get("platform") == native["platform"] and n.get("architecture") == native["architecture"] and n.get("system") == native["system"], "Wrong Quick SSH capture platform"
        assert n.get("scenario") == "quick-ssh-invalid" and t["checks"].get("passed") is True
        for actual in [n, t["checks"]]:
            assert actual.get("inputAddress") == fixture["quickAddress"] and actual.get("terminalFixtureMarker") == fixture["marker"], "Different Quick SSH fixture data"
            for proof in ["invalidInputRejected", "addressRetained", "savedWorkspaceUnchanged", "sameMainWindow", "terminalGenerationRetained", "actualSidebarButton", "actualCancelPreservedState", "workspaceVisibleAroundDialog"]:
                assert actual.get(proof) is True, "Unverified Quick SSH operation: " + proof
            for key in ["modalLeft", "modalTop", "modalWidth", "modalHeight"]:
                assert type(actual.get(key)) in [int, float] and math.isfinite(actual[key]), "Missing actual Quick SSH geometry: " + key
            assert abs(actual["modalWidth"] - min(540, width - 32)) < 1 and 40 <= actual["modalHeight"] <= height - 48, "Quick SSH covers more than its form"
            assert abs(actual["modalLeft"] - (width - actual["modalWidth"]) / 2) < 1 and abs(actual["modalTop"] - (height - actual["modalHeight"]) / 2) < 1, "Quick SSH is not centered"
        for key in ["modalLeft", "modalTop", "modalWidth", "modalHeight"]:
            assert abs(n[key] - t["checks"][key]) < 1, "Different actual Quick SSH geometry: " + key
        name = f"quick-ssh-invalid-{language}-{appearance}-{width}"
        expected_native, expected_tauri = f"personal-initial-{name}.png", f"ui-parity-{name}.png"
        assert t["scenario"] == name and n["screenshot"] == expected_native and t["screenshot"] == expected_tauri and expected_native in native["captures"]
        _, ndigest = image(native_path.parent, expected_native, minimum_height=height)
        _, tdigest = image(tauri_path.parent, expected_tauri, minimum_height=height)
        pairs.append(dict(area="quick-ssh-invalid", language=language, appearance=appearance, width=width, height=height,
                          native=expected_native, tauri=expected_tauri, nativeSHA256=ndigest, tauriSHA256=tdigest))
    expected_pr = {(scene["language"], scene["appearance"], scene["width"], scene["height"]) for scene in fixture["githubScenes"]}
    npr = native.get("githubPRScenes", [])
    tpr = [entry for entry in tauri["scenes"] if entry["scenario"].startswith("github-pr-draft-")]
    assert len(npr) == len(tpr) == len(expected_pr), "Incomplete PR screenshot grid"
    left_pr = {content_key(scene): scene for scene in npr}
    right_pr = {content_key(scene["checks"]): scene for scene in tpr}
    assert set(left_pr) == set(right_pr) == expected_pr, "Missing or duplicate PR scenes"
    for identity in sorted(expected_pr):
        language, appearance, width, height = identity
        n, t = left_pr[identity], right_pr[identity]
        assert n.get("sourceHeadSHA") == head and n.get("testedMergeSHA") == tested, "Stale PR screenshot"
        assert n.get("platform") == native["platform"] and n.get("architecture") == native["architecture"] and n.get("system") == native["system"], "Wrong PR capture platform"
        assert n.get("scenario") == "github-pr-draft" and t["checks"].get("passed") is True
        validate_pr(n, fixture); validate_pr(t["checks"], fixture)
        for key in ["modalLeft", "modalTop", "modalWidth", "modalHeight"]:
            assert abs(n[key] - t["checks"][key]) < 1, "Different actual PR geometry: " + key
        name = f"github-pr-draft-{language}-{appearance}-{width}"
        expected_native, expected_tauri = f"personal-initial-{name}.png", f"ui-parity-{name}.png"
        assert t["scenario"] == name and n["screenshot"] == expected_native and t["screenshot"] == expected_tauri and expected_native in native["captures"]
        _, ndigest = image(native_path.parent, expected_native, minimum_height=height)
        _, tdigest = image(tauri_path.parent, expected_tauri, minimum_height=height)
        pairs.append(dict(area="github-pr-draft", language=language, appearance=appearance, width=width, height=height,
                          native=expected_native, tauri=expected_tauri, nativeSHA256=ndigest, tauriSHA256=tdigest))
    validate_native_run_forms(native, fixture, head, tested, 'initial')
    native_run_forms = []
    for proof in native['runPanelFormProof']:
        _, digest = image(native_path.parent, proof['screenshot'], minimum_height=proof['height'])
        native_run_forms.append(dict(proof, SHA256=digest))
    native_runs = native.get("runPanelScenes", [])
    ordinary_runs = [row["checks"] for row in tauri["scenes"] if row["scenario"].startswith("run-") and row["scenario"] != "run-panels-complete"]
    left_runs = validate_run_panels(native_runs, fixture)
    right_runs = validate_run_panels(ordinary_runs, fixture)
    assert native.get("runPanelActualFileCloseAndHideVerified") is True, "Native run-panel close/hide was not executed"
    completed = [row for row in tauri["scenes"] if row["scenario"] == "run-panels-complete"]
    assert len(completed) == 1 and completed[0]["checks"].get("actualFileCloseAndHideVerified") is True, "Ordinary run-panel close/hide was not executed"
    for identity in sorted(left_runs):
        kind, state, language, appearance, width, height = identity
        n, t = left_runs[identity], right_runs[identity]
        assert n.get("sourceHeadSHA") == head and n.get("testedMergeSHA") == tested, "Stale native run-panel scene"
        assert n.get("platform") == native["platform"] and n.get("architecture") == native["architecture"] and n.get("system") == native["system"]
        name = f"run-{kind}-{state}-{language}-{appearance}-{width}"
        ordinary_scene = next(row for row in tauri["scenes"] if row["checks"] is t)
        assert ordinary_scene["scenario"] == name, "Substituted ordinary run-panel identity"
        expected_native, expected_tauri = f"personal-initial-{name}.png", f"ui-parity-{name}.png"
        assert n.get("screenshot") == expected_native and expected_native in native["captures"]
        assert ordinary_scene.get("screenshot") == expected_tauri
        for key in ["panelLeft", "panelTop", "panelWidth", "panelHeight", "panelHeaderHeight"]:
            assert abs(n[key] - t[key]) < 1, "Different actual run-panel geometry: " + key
        _, ndigest = image(native_path.parent, expected_native, minimum_height=height)
        _, tdigest = image(tauri_path.parent, expected_tauri, minimum_height=height)
        pair = dict(area="run-panel", kind=kind, state=state, language=language, appearance=appearance, width=width, height=height,
                    native=expected_native, tauri=expected_tauri, nativeSHA256=ndigest, tauriSHA256=tdigest,
                    panelGeometry={key: n[key] for key in ["panelLeft", "panelTop", "panelWidth", "panelHeight", "panelHeaderHeight"]})
        pairs.append(pair)
    run_cleanup = completed[0]
    assert run_cleanup.get("screenshot") == "ui-parity-run-panels-complete.png", "Substituted ordinary run-panel cleanup capture"
    for key in ["passed", "terminalGenerationRetained", "canonicalWorkspaceRetained"]:
        assert run_cleanup["checks"].get(key) is True, "Unverified run-panel cleanup: " + key
    run_cleanup_file, run_cleanup_digest = image(tauri_path.parent, run_cleanup["screenshot"])
    output.mkdir(parents=True, exist_ok=False)
    for pair in pairs:
        shutil.copyfile(native_path.parent / pair["native"], output / pair["native"])
        shutil.copyfile(tauri_path.parent / pair["tauri"], output / pair["tauri"])
    shutil.copyfile(restart_file, output / restart_file.name)
    shutil.copyfile(run_cleanup_file, output / run_cleanup_file.name)
    for proof in native_run_forms:
        shutil.copyfile(native_path.parent / proof['screenshot'], output / proof['screenshot'])
    result = dict(sourceHeadSHA=head, testedMergeSHA=tested, uiParityFixtureSHA256=fixture_digest,
                  chromeContractSHA256=chrome_digest,
                  platform="macOS", architecture="arm64", system=native["system"], pairs=pairs,
                  ordinaryRestart=dict(screenshot=restart_file.name, SHA256=restart_digest, checks=checks),
                  ordinaryRunPanelsCleanup=dict(screenshot=run_cleanup_file.name, SHA256=run_cleanup_digest, checks=run_cleanup["checks"]),
                  nativeRunFormEvidence=native_run_forms,
                  comparisonReady=True, functionalParityAccepted=False,
                  scope="Workspace, settings, PDF, Quick SSH, GitHub PR and Java/Python docked/expanded/file screenshots. PR uses the isolated simulated CLI, literal form input and actual Cancel; no real GitHub write. PDF comparison data is seeded; deletion and reopen use actual controls; native drawing uses window pointer events. Quick SSH uses an invalid fixture address, actual modal controls and real shell output; no authenticated login claim. Review images and execute remaining acceptance rows.")
    (output / "comparison.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    write_viewer(output, result)
    rows = ["# Real-window comparison / 真实窗口对照", "", f"Source head: `{head}`", f"Tested merge: `{tested}`", "",
            "These are original CI images. Functional parity remains pending.", "原图来自 CI；功能一致性仍待验收。", "",
            "[Open the offline scene viewer / 打开离线场景对照](comparison.html)", "",
            "| Scene / 场景 | Ordinary / 普通版 | Personal / 原生个人版 |", "| --- | --- | --- |"]
    for pair in pairs:
        label = f"{pair['area']} {pair.get('section', pair.get('kind', ''))} {pair.get('state', '')} / {pair['language']} / {pair['appearance']} / {pair['width']}×{pair['height']}"
        rows.append(f"| {label} | ![ordinary]({pair['tauri']}) | ![personal]({pair['native']}) |")
    rows.extend(["", "Actual ordinary restart / 普通版实际重启", "", f"![restart]({restart_file.name})"])
    rows.extend(["", "Actual ordinary run-panel cleanup / 普通版运行面板实际清理", "", f"![run-panel cleanup]({run_cleanup_file.name})"])
    rows.extend(["", "Additional native form controls (unpaired) / 补充原生表单控件（未配对）", ""])
    for proof in native_run_forms:
        rows.extend([f"{proof['kind']} / {proof['language']} / {proof['appearance']} / {proof['width']}×{proof['height']}", "", f"![native form]({proof['screenshot']})", ""])
    (output / "comparison.md").write_text("\n".join(rows) + "\n")
    return result


def find_native_run(repository, head, artifact_name):
    assert re.fullmatch(r"[\w.-]+/[\w.-]+", repository) and re.fullmatch(r"[0-9a-f]{40}", head)
    def request(path):
        req = urllib.request.Request("https://api.github.com/repos/" + repository + path,
            headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"], "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=30) as reply:
            return json.load(reply)
    for _ in range(240):
        runs = request(f"/actions/runs?head_sha={head}&per_page=100")["workflow_runs"]
        candidates = [run for run in runs if run["name"] == "macOS personal packages" and run["head_sha"] == head and run.get("event") in ["pull_request", "workflow_dispatch"]]
        if candidates:
            run = max(candidates, key=lambda candidate: candidate["id"])
            artifacts = request(f"/actions/runs/{run['id']}/artifacts?per_page=100")["artifacts"]
            if any(artifact["name"] == artifact_name and not artifact["expired"] for artifact in artifacts):
                print(run["id"])
                return
            assert run["status"] != "completed", f"Native run {run['html_url']} completed without the required artifact"
        time.sleep(15)
    raise RuntimeError("Native artifacts were not available within the 60-minute evidence wait")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    finder = commands.add_parser("find-native-run")
    finder.add_argument("repository")
    finder.add_argument("head")
    finder.add_argument("artifact")
    check = commands.add_parser("compare")
    for name in ["native", "tauri", "output", "head", "tested"]:
        check.add_argument("--" + name, required=True)
    check.add_argument("--fixture", default="shared/fixtures/client-ui-parity.json")
    args = parser.parse_args()
    if args.command == "find-native-run":
        find_native_run(args.repository, args.head, args.artifact)
    else:
        compare(args.native, args.tauri, args.output, args.head, args.tested, args.fixture)
