import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "interaction_matrix", Path(__file__).resolve().parents[1] / "scripts/interaction-matrix.py"
)
matrix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matrix)


class InteractionEvidenceTests(unittest.TestCase):
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
