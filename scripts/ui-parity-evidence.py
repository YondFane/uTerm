"""Compare source-bound real-window artifacts. 对照绑定源码的真实窗口产物。"""

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import time
import urllib.request
from pathlib import Path


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


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
    for report, source, merge in [(native, "sourceHeadSHA", "testedMergeSHA"), (tauri, "head", "tested")]:
        assert report.get("passed") is True and not report.get("failure") and not report.get("cleanupErrors"), "Unaccepted application run"
        assert report.get(source) == head and report.get(merge) == tested, "Wrong source or tested merge SHA"
        assert report.get("productionDataAccess") is False and not report.get("sourceTreeDirty", False), "Unisolated or dirty run"
        assert report.get("uiParityFixtureSHA256") == fixture_digest, "Different fixture data"
    assert native["platform"] == "macOS" and tauri["platform"] == "darwin"
    assert native["architecture"] == tauri["architecture"] == "arm64", "Different capture architecture"
    assert re.search(r"\d+\.\d+(?:\.\d+)?", native["system"])[0] == tauri["productVersion"], "Different macOS version"
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
        assert n["scenario"] == t["checks"]["scenario"] == "toolbar-sidebar-two-session-tabs-files"
        assert n["filesReadable"] is True and t["checks"]["filesReadable"] is True
        assert n["fontSize"] == t["checks"]["fontSize"] == fixture["fontSize"]
        assert n["projectName"] == t["checks"]["projectName"] == fixture["projectName"]
        assert n["workspaceName"] == t["checks"]["workspaceName"] == fixture["workspaceName"]
        assert t["checks"].get("generationRetained") is True and t["checks"]["projectName"] == fixture["projectName"]
        assert expected_native in native["captures"]
        nfile, ndigest = image(native_path.parent, expected_native)
        tfile, tdigest = image(tauri_path.parent, expected_tauri)
        pairs.append(dict(language=language, appearance=appearance, width=width, height=fixture["height"],
                          area="workspace",
                          native=expected_native, tauri=expected_tauri, nativeSHA256=ndigest, tauriSHA256=tdigest))
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
        pairs.append(dict(area="settings", section=section, language=language, appearance=appearance, width=width, height=height,
                          native=expected_native, tauri=expected_tauri, nativeSHA256=ndigest, tauriSHA256=tdigest))
    output.mkdir(parents=True, exist_ok=False)
    for pair in pairs:
        shutil.copyfile(native_path.parent / pair["native"], output / pair["native"])
        shutil.copyfile(tauri_path.parent / pair["tauri"], output / pair["tauri"])
    result = dict(sourceHeadSHA=head, testedMergeSHA=tested, uiParityFixtureSHA256=fixture_digest,
                  platform="macOS", architecture="arm64", system=native["system"], pairs=pairs,
                  comparisonReady=True, functionalParityAccepted=False,
                  scope="Workspace and settings navigation screenshots; review images and execute remaining acceptance rows.")
    (output / "comparison.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    rows = ["# Real-window comparison / 真实窗口对照", "", f"Source head: `{head}`", f"Tested merge: `{tested}`", "",
            "These are original CI images. Functional parity remains pending.", "原图来自 CI；功能一致性仍待验收。", "",
            "| Scene / 场景 | Ordinary / 普通版 | Personal / 原生个人版 |", "| --- | --- | --- |"]
    for pair in pairs:
        label = f"{pair['area']} {pair.get('section', '')} / {pair['language']} / {pair['appearance']} / {pair['width']}×{pair['height']}"
        rows.append(f"| {label} | ![ordinary]({pair['tauri']}) | ![personal]({pair['native']}) |")
    (output / "comparison.md").write_text("\n".join(rows) + "\n")
    return result


def find_native_run(repository, head, artifact_name):
    assert re.fullmatch(r"[\w.-]+/[\w.-]+", repository) and re.fullmatch(r"[0-9a-f]{40}", head)
    def request(path):
        req = urllib.request.Request("https://api.github.com/repos/" + repository + path,
            headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"], "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=30) as reply:
            return json.load(reply)
    for _ in range(120):
        runs = request(f"/actions/runs?head_sha={head}&event=pull_request&per_page=100")["workflow_runs"]
        candidates = [run for run in runs if run["name"] == "macOS personal packages" and run["head_sha"] == head]
        if candidates:
            run = max(candidates, key=lambda candidate: candidate["id"])
            artifacts = request(f"/actions/runs/{run['id']}/artifacts?per_page=100")["artifacts"]
            if any(artifact["name"] == artifact_name and not artifact["expired"] for artifact in artifacts):
                print(run["id"])
                return
            assert run["status"] != "completed", f"Native run {run['html_url']} completed without the required artifact"
        time.sleep(15)
    raise RuntimeError("Native artifacts were not available within the 30-minute evidence wait")


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
