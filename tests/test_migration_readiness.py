import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location("migration_readiness", Path(__file__).resolve().parents[1] / "scripts/migration-readiness.py")
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)


class EvidenceTests(unittest.TestCase):
    def test_native_report_without_clean_source_metadata_remains_blocked(self):
        head, merge = "a" * 40, "b" * 40
        report = dict(passed=True, sourceHeadSHA=head, sourceSHA=merge, productionDataAccess=False)
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "native.zip"
            with ZipFile(archive, "w") as bundle:
                bundle.writestr("input-control-owner.json", json.dumps(report))
            actual = readiness.inspect_evidence(archive, head)
            self.assertEqual(actual["testedMergeSHAs"], [merge])
            self.assertEqual(len(actual["reports"]), 1)
            self.assertTrue(any("Unclean source" in error for error in actual["errors"]))

    def test_stale_failed_dirty_and_incomplete_artifacts_remain_blocked(self):
        head, merge = "a" * 40, "b" * 40
        report = dict(passed=True, sourceHeadSHA=head, testedMergeSHA=merge, sourceTreeDirty=False)
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "evidence.zip"
            for change in [None, {"sourceHeadSHA": "c" * 40}, {"testedMergeSHA": "unknown"},
                           {"passed": False}, {"sourceTreeDirty": True}, {"productionDataAccess": True},
                           {"stableCutoverAccepted": False}, {"performanceAcceptanceComplete": False},
                           {"cleanupErrors": ["owned process remains"]}, {"failure": "bad signature"}]:
                with self.subTest(change=change):
                    with ZipFile(archive, "w") as bundle:
                        bundle.writestr("report.json", json.dumps({**report, **(change or {})}))
                        bundle.writestr("window.png", b"\x89PNG\r\n\x1a\n")
                    actual = readiness.inspect_evidence(archive, head)
                    self.assertEqual(bool(actual["errors"]), change is not None)
                    self.assertEqual(actual["screenshots"], ["window.png"])
            with ZipFile(archive, "w") as bundle:
                bundle.writestr("report.json", json.dumps({"passed": True}))
                bundle.writestr("window.png", b"design illustration")
            actual = readiness.inspect_evidence(archive, head)
            self.assertTrue(any("no source-bound" in value for value in actual["errors"]))
            self.assertTrue(any("PNG" in value for value in actual["errors"]))


if __name__ == "__main__":
    unittest.main()
