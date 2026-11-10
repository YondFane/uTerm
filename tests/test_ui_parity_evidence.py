import copy
import hashlib
import importlib.util
import json
import struct
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("parity_evidence", Path(__file__).parents[1] / "scripts/ui-parity-evidence.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ParityEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.native = self.root / "native"
        self.tauri = self.root / "tauri"
        self.native.mkdir()
        self.tauri.mkdir()
        self.fixture = Path(__file__).parents[1] / "shared/fixtures/client-ui-parity.json"
        fixture = module.read_json(self.fixture)
        digest = hashlib.sha256(self.fixture.read_bytes()).hexdigest()
        self.n = dict(passed=True, platform="macOS", architecture="arm64", system="Version 15.8.2",
                      sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, productionDataAccess=False,
                      uiParityFixtureSHA256=digest, backgroundTabCloseRetainedSelectedGeneration=True,
                      workspaceScenes=[], settingsScenes=[], captures=[])
        self.t = dict(passed=True, platform="darwin", architecture="arm64", productVersion="15.8.2",
                      head="a" * 40, tested="b" * 40, productionDataAccess=False, sourceTreeDirty=False,
                      uiParityFixtureSHA256=digest, scenes=[])
        for lang in fixture["languages"]:
            for appearance in fixture["appearances"]:
                for width in fixture["widths"]:
                    values = dict(language=lang, appearance=appearance, width=width, height=720,
                                  scenario="toolbar-sidebar-two-session-tabs-files", sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40,
                                  generationRetained=True, filesReadable=True, fontSize=17, projectName=fixture["projectName"], workspaceName=fixture["workspaceName"])
                    native = f"personal-initial-workspace-{lang}-{appearance}-{width}.png"
                    tauri = f"ui-parity-workspace-{lang}-{appearance}-{width}.png"
                    # Synthetic header fixtures test rejection policy, never native acceptance.
                    # 合成文件头样例仅测试拒绝策略，不属于原生验收证据。
                    image = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, 720) + bytes(1100)
                    (self.native / native).write_bytes(image)
                    (self.tauri / tauri).write_bytes(image)
                    self.n["workspaceScenes"].append(dict(values, screenshot=native))
                    self.n["captures"].append(native)
                    self.t["scenes"].append(dict(scenario=f"workspace-{lang}-{appearance}-{width}", checks=values, screenshot=tauri))
        for scene in fixture["settingsScenes"]:
            for section in fixture["settingsSections"]:
                values = dict(scene, section=section["id"], navigationControlActivated=True, draftUnchanged=True, automaticUpdates=fixture["automaticUpdates"])
                name = f"settings-{section['id']}-{scene['language']}-{scene['appearance']}-{scene['width']}"
                native, tauri = f"personal-initial-{name}.png", f"ui-parity-{name}.png"
                image = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", scene["width"], scene["height"]) + bytes(1100)
                (self.native / native).write_bytes(image)
                (self.tauri / tauri).write_bytes(image)
                self.n["settingsScenes"].append(dict(values, screenshot=native, sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40,
                                                    platform="macOS", architecture="arm64", system=self.n["system"]))
                self.n["captures"].append(native)
                self.t["scenes"].append(dict(scenario=name, checks=values, screenshot=tauri))

    def run_compare(self):
        for root, name, report in [(self.native, "personal-initial.json", self.n), (self.tauri, "report.json", self.t)]:
            (root / name).write_text(json.dumps(report))
        return module.compare(self.native / "personal-initial.json", self.tauri / "report.json", self.root / "comparison",
                              "a" * 40, "b" * 40, self.fixture)

    def test_common_fixture_preserves_exact_note_bytes_and_shell_newline(self):
        fixture = module.read_json(self.fixture)
        self.assertEqual(fixture["files"]["note.txt"].encode(), "Original 中文\r\n".encode())
        self.assertTrue(fixture["files"]["README.md"].startswith("# UI parity\n"))
        self.assertEqual(fixture["command"], "printf 'PERSONAL_%s 中文\\n' READY")

    def test_complete_pair_is_reviewable_but_does_not_claim_functional_parity(self):
        result = self.run_compare()
        self.assertTrue(result["comparisonReady"])
        self.assertFalse(result["functionalParityAccepted"])
        self.assertEqual(len(result["pairs"]), 26)
        self.assertEqual(len(list((self.root / "comparison").glob("*.png"))), 52)

    def test_settings_scenes_require_complete_source_bound_unchanged_navigation(self):
        original = copy.deepcopy(self.n["settingsScenes"])
        for mutation in ["missing", "duplicate", "stale", "draft", "navigation", "height"]:
            self.n["settingsScenes"] = copy.deepcopy(original)
            if mutation == "missing": self.n["settingsScenes"].pop()
            if mutation == "duplicate": self.n["settingsScenes"][0] = self.n["settingsScenes"][1]
            if mutation == "stale": self.n["settingsScenes"][0]["testedMergeSHA"] = "c" * 40
            if mutation == "draft": self.n["settingsScenes"][0]["draftUnchanged"] = False
            if mutation == "navigation": self.n["settingsScenes"][0]["navigationControlActivated"] = False
            if mutation == "height": self.n["settingsScenes"][0]["height"] = 639
            with self.subTest(mutation=mutation), self.assertRaises(AssertionError): self.run_compare()

    def test_rejects_stale_sources_failed_runs_wrong_architecture_and_different_fixtures(self):
        for key, value in [("tested", "c" * 40), ("head", "c" * 40), ("passed", False),
                           ("architecture", "x64"), ("productionDataAccess", True), ("sourceTreeDirty", True),
                           ("uiParityFixtureSHA256", "0" * 64), ("productVersion", "15.7.9")]:
            original = copy.deepcopy(self.t)
            self.t[key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                self.run_compare()
            self.t = original

    def test_rejects_missing_and_duplicate_scene_records(self):
        original = copy.deepcopy(self.n)
        self.n["workspaceScenes"].pop()
        with self.assertRaises(AssertionError): self.run_compare()
        self.n = original
        self.n["workspaceScenes"][0] = self.n["workspaceScenes"][1]
        with self.assertRaises(AssertionError): self.run_compare()

    def test_rejects_missing_or_tiny_images(self):
        path = self.native / self.n["captures"][0]
        path.write_bytes(b"\x89PNG\r\n\x1a\n")
        with self.assertRaises(AssertionError): self.run_compare()
        path.unlink()
        with self.assertRaises(FileNotFoundError): self.run_compare()

    def test_rejects_scene_source_mismatch_and_unverified_background_close(self):
        self.n["workspaceScenes"][0]["testedMergeSHA"] = "c" * 40
        with self.assertRaises(AssertionError): self.run_compare()
        self.n["workspaceScenes"][0]["testedMergeSHA"] = "b" * 40
        self.n["backgroundTabCloseRetainedSelectedGeneration"] = False
        with self.assertRaises(AssertionError): self.run_compare()
        self.n["backgroundTabCloseRetainedSelectedGeneration"] = True
        self.n["workspaceScenes"][0]["filesReadable"] = False
        with self.assertRaises(AssertionError): self.run_compare()
        self.n["workspaceScenes"][0]["filesReadable"] = True
        self.n["workspaceScenes"][0]["workspaceName"] = "Different workspace"
        with self.assertRaises(AssertionError): self.run_compare()

    def test_rejects_images_outside_the_artifact(self):
        path = self.native / self.n["captures"][0]
        outside = self.root / "outside.png"
        path.rename(outside)
        path.symlink_to(outside)
        with self.assertRaises(AssertionError): self.run_compare()


if __name__ == "__main__":
    unittest.main()
