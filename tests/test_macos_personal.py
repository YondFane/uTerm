import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
spec = importlib.util.spec_from_file_location("personal_package", Path(__file__).resolve().parents[1] / "scripts/macos-personal-package.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PersonalPackageTests(unittest.TestCase):
    def setUp(self):
        self.info = dict(CFBundleIdentifier="sh.uterm.desktop.personal", CFBundleExecutable="uTerm",
                         UTermBuildFlavor="personal", UTermUpdateMode="manual", UTermSourceHeadSHA="a" * 40,
                         UTermSourceSHA="b" * 40, CFBundleShortVersionString="0.2.4", LSMinimumSystemVersion="14.0",
                         SUEnableAutomaticChecks=False, SUAutomaticallyUpdate=False, SUAllowsAutomaticUpdates=False)

    def test_mislabeled_qa_or_stale_source_cannot_be_distributed_as_personal(self):
        package.validate_info(self.info, "a" * 40, "b" * 40)
        for key, value in [("CFBundleIdentifier", "sh.uterm.desktop.qa.native"), ("UTermSourceSHA", "c" * 40),
                           ("UTermSourceHeadSHA", "c" * 40), ("UTermBuildFlavor", "qa"), ("UTermUpdateMode", "automatic")]:
            with self.subTest(key=key):
                info = {**self.info, key: value}
                with self.assertRaises(AssertionError):
                    package.validate_info(info, "a" * 40, "b" * 40)

    def test_embedded_qa_roots_or_update_feeds_are_rejected_even_with_opt_out(self):
        for key in ["UTermQADataRoot", "UTermUpdateFeedURL", "SUFeedURL", "SUPublicEDKey", "CFBundleURLTypes"]:
            with self.subTest(key=key), self.assertRaises(AssertionError):
                package.validate_info({**self.info, key: "unexpected"}, "a" * 40, "b" * 40)
        for key in ["SUEnableAutomaticChecks", "SUAutomaticallyUpdate", "SUAllowsAutomaticUpdates"]:
            for value in [True, "false", 0, None]:
                with self.subTest(key=key, value=value), self.assertRaises(AssertionError):
                    package.validate_info({**self.info, key: value}, "a" * 40, "b" * 40)

    def test_selected_dark_setting_does_not_replace_actual_window_appearance_evidence(self):
        report = dict(passed=True, automaticOptInCannotStartUpdater=True, explicitCloseAndIdleHostShutdown=True,
                      sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, profileRetainedAfterAppReplacement=True,
                      settingsWindowAppearances={"en-dark": "NSAppearanceNameDarkAqua", "zh-Hans-light": "NSAppearanceNameAqua"})
        package.validate_smoke_report(report, "a" * 40, "b" * 40, "replacement")
        report["settingsWindowAppearances"]["en-dark"] = "NSAppearanceNameAqua"
        report["storedAppearance"] = "dark"
        with self.assertRaises(AssertionError):
            package.validate_smoke_report(report, "a" * 40, "b" * 40, "replacement")

    def test_shipping_metadata_cannot_have_candidate_version_or_raised_minimum(self):
        for key, value in [("CFBundleShortVersionString", "0.0.1 QA"), ("LSMinimumSystemVersion", "15.0")]:
            with self.subTest(key=key), self.assertRaises(AssertionError):
                package.validate_info({**self.info, key: value}, "a" * 40, "b" * 40)


if __name__ == "__main__":
    unittest.main()
