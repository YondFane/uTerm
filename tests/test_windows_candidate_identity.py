import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "candidate_identity", Path(__file__).resolve().parents[1] / "scripts/windows-candidate-identity.py"
)
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class CandidateIdentityTests(unittest.TestCase):
    def test_only_unique_nsis_marker_transform_is_accepted(self):
        built = b"MZ" + bytes(range(256)) * 280 + identity.UNKNOWN + b"embedded resources"
        installed = built.replace(identity.UNKNOWN, identity.NSIS)
        self.assertTrue(identity.compare(built, installed)["binaryMatchesExpectedNSIS"])
        self.assertGreater(identity.compare(built, installed)["bundleTypeMarkerOffset"], 65536)
        for changed in (installed[:-1] + b"!", installed + b"extra", b"!" + installed[1:], built):
            with self.subTest(changed=changed[-24:]):
                self.assertFalse(identity.compare(built, changed)["binaryMatchesExpectedNSIS"])

    def test_missing_ambiguous_and_wrong_bundle_type_are_rejected(self):
        for built in (b"MZ", identity.UNKNOWN * 2, identity.UNKNOWN + identity.NSIS):
            self.assertFalse(identity.compare(built, built.replace(identity.UNKNOWN, identity.NSIS))["binaryMatchesExpectedNSIS"])
        self.assertFalse(identity.compare(identity.UNKNOWN, identity.UNKNOWN.replace(b"UNK", b"MSI"))["binaryMatchesExpectedNSIS"])


if __name__ == "__main__":
    unittest.main()
