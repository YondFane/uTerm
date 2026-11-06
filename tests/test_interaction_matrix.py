import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "interaction_matrix", Path(__file__).resolve().parents[1] / "scripts/interaction-matrix.py"
)
matrix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matrix)


class InteractionEvidenceTests(unittest.TestCase):
    def test_relative_capture_paths_and_unicode_reports_use_artifact_root(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            names = ["editor-saved", "preview-returned-editor", "git-worktree", "theme-imported", "input-owner-returned", "input-owner-closed", "input-viewer-owned"]
            source = {"head": "head", "tested": "merge", "productionDataAccess": False}
            scenes = []
            for name in names:
                image = name + ".png"
                (root / image).write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(1024))
                scenes.append({**source, "scenario": name, "screenshot": image, "checks": {"text": "中文 é"}})
            report = {**source, "passed": True, "platform": "win32", "architecture": "x64", "system": "fixture", "scenes": scenes}
            (root / "report.json").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
            result = matrix.tauri_matrix(root, "head", "merge")
            self.assertEqual(len(result["captures"]), len(names))
            scenes[0]["screenshot"] = "../escape.png"
            (root / "report.json").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
            with self.assertRaises(ValueError):
                matrix.tauri_matrix(root, "head", "merge")

    def test_source_and_tested_merge_must_both_match_and_failures_stay_failed(self):
        valid = {"sourceHeadSHA": "head", "testedMergeSHA": "merge", "sourceTreeDirty": False, "productionDataAccess": False}
        matrix.verify_source(valid, "head", "merge")
        for changes in ({"sourceHeadSHA": "old"}, {"testedMergeSHA": "old"}, {"sourceTreeDirty": True}, {"productionDataAccess": True}, {"failure": "failed"}, {"cleanupErrors": ["host survived"]}):
            with self.subTest(changes=changes), self.assertRaises(AssertionError):
                matrix.verify_source({**valid, **changes}, "head", "merge")

    def test_original_image_files_must_exist_inside_artifact_directory(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            (root / "fixture.png").write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(1024))
            self.assertEqual(matrix.image_evidence(root, ["fixture.png"]), ["fixture.png"])
            for names in ([], ["missing.png"], ["../fixture.png"]):
                with self.subTest(names=names), self.assertRaises((AssertionError, FileNotFoundError)):
                    matrix.image_evidence(root, names)
            (root / "fixture.png").write_text("not an original PNG" * 100)
            with self.assertRaises(AssertionError):
                matrix.image_evidence(root, ["fixture.png"])


if __name__ == "__main__":
    unittest.main()
