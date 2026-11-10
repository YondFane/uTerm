import importlib.util
import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
spec = importlib.util.spec_from_file_location("personal_package", Path(__file__).resolve().parents[1] / "scripts/macos-personal-package.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PersonalPackageTests(unittest.TestCase):
    def test_failed_acceptance_keeps_raw_report_and_available_images(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            evidence = Path(temporary) / "evidence"
            root.mkdir()
            evidence.mkdir()
            raw = json.dumps(dict(passed=False, failure="Window too short", captures=["failure.png"]))
            (root / "personal-initial.json").write_text(raw)
            image = b"\x89PNG\r\n\x1a\npolicy-test-only"
            (root / "failure.png").write_bytes(image)
            report, captures = package.preserve_smoke_outputs(root, evidence, "initial")
            with self.assertRaises(AssertionError):
                package.validate_smoke_report(report, "a" * 40, "b" * 40, "initial")
            self.assertEqual((evidence / "personal-initial.json").read_text(), raw)
            self.assertEqual((evidence / "failure.png").read_bytes(), image)
            self.assertEqual(captures, ["failure.png"])

    def test_capture_paths_cannot_escape_the_isolated_smoke_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            evidence = Path(temporary) / "evidence"
            root.mkdir()
            evidence.mkdir()
            outside = Path(temporary) / "outside.png"
            outside.write_bytes(b"\x89PNG\r\n\x1a\npolicy-test-only")
            (root / "linked.png").symlink_to(outside)
            for name in ["../outside.png", str(outside), "linked.png"]:
                with self.subTest(name=name):
                    (root / "personal-initial.json").write_text(json.dumps(dict(passed=False, captures=[name])))
                    with self.assertRaises(AssertionError):
                        package.preserve_smoke_outputs(root, evidence, "initial")
                    self.assertFalse((evidence / "outside.png").exists())
                    self.assertFalse((evidence / "linked.png").exists())

    def setUp(self):
        self.info = dict(CFBundleIdentifier="sh.uterm.desktop.personal", CFBundleExecutable="uTerm",
                         UTermBuildFlavor="personal", UTermUpdateMode="manual", UTermSourceHeadSHA="a" * 40,
                         UTermSourceSHA="b" * 40, CFBundleShortVersionString="0.2.4", LSMinimumSystemVersion="14.0",
                         SUEnableAutomaticChecks=False, SUAutomaticallyUpdate=False, SUAllowsAutomaticUpdates=False)

    def workspace_evidence(self, phase):
        scenes = [dict(language=language, appearance=appearance, width=width, height=720,
                       screenshot=f"personal-{phase}-workspace-{language}-{appearance}-{width}.png",
                       sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, platform="macOS", architecture="arm64",
                       system="macOS fixture", filesReadable=True, scenario="toolbar-sidebar-two-session-tabs-files")
                  for language in ["en", "zh-Hans"] for appearance in ["dark", "light"] for width in [1100, 640]]
        return dict(backgroundTabCloseRetainedSelectedGeneration=True, workspaceScenes=scenes,
                    captures=[scene["screenshot"] for scene in scenes])

    def test_workspace_acceptance_rejects_missing_duplicate_or_wrong_source_screenshots(self):
        for mutation in ["missing", "duplicate", "source", "file", "background-close", "unreadable-files"]:
            report = self.workspace_evidence("initial")
            if mutation == "missing": report["workspaceScenes"].pop()
            if mutation == "duplicate": report["workspaceScenes"][0] = report["workspaceScenes"][1]
            if mutation == "source": report["workspaceScenes"][0]["testedMergeSHA"] = "c" * 40
            if mutation == "file": report["captures"].pop()
            if mutation == "background-close": report["backgroundTabCloseRetainedSelectedGeneration"] = False
            if mutation == "unreadable-files": report["workspaceScenes"][0]["filesReadable"] = False
            with self.subTest(mutation=mutation), self.assertRaises(AssertionError):
                package.validate_workspace_scenes(report, "a" * 40, "b" * 40, "initial")

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
        report = dict(**self.workspace_evidence("replacement"), passed=True, automaticOptInCannotStartUpdater=True, explicitCloseAndIdleHostShutdown=True,
                      sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, profileRetainedAfterAppReplacement=True,
                      settingsWindowAppearances={"en-dark": "NSAppearanceNameDarkAqua", "zh-Hans-light": "NSAppearanceNameAqua"})
        package.validate_smoke_report(report, "a" * 40, "b" * 40, "replacement")
        report["settingsWindowAppearances"]["en-dark"] = "NSAppearanceNameAqua"
        report["storedAppearance"] = "dark"
        with self.assertRaises(AssertionError):
            package.validate_smoke_report(report, "a" * 40, "b" * 40, "replacement")

    def test_update_status_evidence_must_follow_the_selected_language(self):
        report = dict(**self.workspace_evidence("initial"), passed=True, automaticOptInAndOutVerified=True, updateMode="automatic",
                      explicitCloseAndIdleHostShutdown=True, sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40,
                      settingsWindowAppearances={"en-dark": "NSAppearanceNameDarkAqua", "zh-Hans-light": "NSAppearanceNameAqua"},
                      localizedUpdateStatuses={"en": "You’re up to date.", "zh-Hans": "当前已是最新版本。"})
        package.validate_smoke_report(report, "a" * 40, "b" * 40, "initial")
        report["localizedUpdateStatuses"]["zh-Hans"] = "You’re up to date."
        with self.assertRaises(AssertionError):
            package.validate_smoke_report(report, "a" * 40, "b" * 40, "initial")

    def test_shipping_metadata_cannot_have_candidate_version_or_raised_minimum(self):
        for key, value in [("CFBundleShortVersionString", "0.0.1 QA"), ("LSMinimumSystemVersion", "15.0")]:
            with self.subTest(key=key), self.assertRaises(AssertionError):
                package.validate_info({**self.info, key: value}, "a" * 40, "b" * 40)

    def test_automatic_packages_require_a_real_key_and_the_dedicated_feed(self):
        info = {**self.info, "UTermUpdateMode": "automatic", "SUAllowsAutomaticUpdates": True,
                "SUPublicEDKey": base64.b64encode(bytes(range(32))).decode(), "SUVerifyUpdateBeforeExtraction": True,
                "UTermUpdateFeedURL": "https://github.com/YondFane/uTerm/releases/download/uTerm-updates/personal-stable-arm64.xml",
                "UTermUpdateChannel": "stable", "CFBundleVersion": self.info["CFBundleShortVersionString"]}
        package.validate_info(info, "a" * 40, "b" * 40)
        for key, value in [("SUPublicEDKey", base64.b64encode(bytes(31)).decode()), ("SUAllowsAutomaticUpdates", False),
                           ("UTermUpdateFeedURL", "http://127.0.0.1/appcast.xml"), ("UTermUpdateChannel", "preview"),
                           ("CFBundleVersion", "123"), ("UTermQAUpdateReport", "qa.json"),
                           ("UTermUpdateFeedURL", "https://github.com/other/repo/releases/download/uTerm-updates/personal-stable-arm64.xml")]:
            with self.subTest(key=key), self.assertRaises(AssertionError):
                package.validate_info({**info, key: value}, "a" * 40, "b" * 40)


if __name__ == "__main__":
    unittest.main()
