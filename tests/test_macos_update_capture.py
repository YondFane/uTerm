import importlib.util
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
spec = importlib.util.spec_from_file_location("update_smoke", Path(__file__).resolve().parents[1] / "scripts/macos-updates-smoke.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class UpdateCaptureBoundaries(unittest.TestCase):
    def test_relaunched_capture_requires_exact_source_identity_and_safe_target(self):
        request = dict(sourceHeadSHA="head", testedMergeSHA="merge", bundleIdentifier="qa.identity", pid=20,
                       windowNumber=41, screenshot="native-update-install-relaunched.png")

        def validate(value):
            smoke.validate_capture_request(value, "head", "merge", "qa.identity", 10)

        validate(request)
        for changes in [dict(sourceHeadSHA="old"), dict(testedMergeSHA="old"), dict(bundleIdentifier="production"),
                        dict(pid=10), dict(pid=True), dict(pid="20"), dict(pid=0), dict(windowNumber=False),
                        dict(windowNumber=-1), dict(screenshot="../other.png")]:
            with self.subTest(changes=changes), self.assertRaises(AssertionError):
                validate({**request, **changes})


if __name__ == "__main__":
    unittest.main()
