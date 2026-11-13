import importlib.util
import base64
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
spec = importlib.util.spec_from_file_location("personal_package", Path(__file__).resolve().parents[1] / "scripts/macos-personal-package.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PersonalPackageTests(unittest.TestCase):
    def test_occluded_attempt_keeps_original_and_visibility_without_changing_failed_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, evidence = Path(temporary) / "source", Path(temporary) / "evidence"
            root.mkdir(); evidence.mkdir()
            raw = json.dumps(dict(passed=False, failure="SMOKE_CAPTURE_OCCLUDED", captures=[]))
            (root / "personal-initial.json").write_text(raw)
            name = "personal-initial-settings.png"
            image = b"\x89PNG\r\n\x1a\npolicy-test-only"
            (root / name).write_bytes(image)
            visibility = json.dumps(dict(passed=False, before=[dict(owner="QA fixture")], after=[]))
            (root / (name + ".visibility.json")).write_text(visibility)
            report, captures = package.preserve_smoke_outputs(root, evidence, "initial")
            self.assertEqual((evidence / name).read_bytes(), image)
            self.assertEqual((evidence / (name + ".visibility.json")).read_text(), visibility)
            self.assertEqual((evidence / "personal-initial.json").read_text(), raw)
            self.assertFalse(report["passed"])
            self.assertEqual(captures, [])

    def test_visibility_sidecar_cannot_follow_a_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, evidence = Path(temporary) / "source", Path(temporary) / "evidence"
            root.mkdir(); evidence.mkdir()
            (root / "image.png").write_bytes(b"\x89PNG\r\n\x1a\npolicy-test-only")
            outside = Path(temporary) / "outside.json"
            outside.write_text('{"passed": true}')
            (root / "image.png.visibility.json").symlink_to(outside)
            with self.assertRaises(AssertionError):
                package.preserve_capture(root, evidence, "image.png")
            self.assertFalse((evidence / "image.png.visibility.json").exists())

    def test_missing_final_report_retains_progress_and_actual_partial_images(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, evidence = Path(temporary) / "source", Path(temporary) / "evidence"
            root.mkdir(); evidence.mkdir()
            progress = dict(passed=False, inProgress=True, stage="settings-en-maven", sourceHeadSHA="a" * 40,
                            testedMergeSHA="b" * 40, elapsedSeconds=87)
            raw = json.dumps(progress)
            (root / "personal-initial-progress.json").write_text(raw)
            image = b"\x89PNG\r\n\x1a\npolicy-test-only"
            (root / "personal-initial-settings.png").write_bytes(image)
            package.preserve_incomplete_smoke(root, evidence, "initial", "timeout", "a" * 40, "b" * 40)
            self.assertEqual((evidence / "personal-initial-progress.json").read_text(), raw)
            self.assertEqual((evidence / "personal-initial-settings.png").read_bytes(), image)
            report = json.loads((evidence / "personal-initial-incomplete.json").read_text())
            self.assertFalse(report["passed"])
            self.assertTrue(report["incomplete"])
            self.assertEqual(report["lastProgress"], progress)
            self.assertEqual(report["captures"], ["personal-initial-settings.png"])
            self.assertFalse((evidence / "personal-initial.json").exists())
            with self.assertRaises(AssertionError):
                package.validate_smoke_report(report, "a" * 40, "b" * 40, "initial")

    def test_incomplete_capture_and_progress_cannot_follow_symlinks(self):
        for kind in ["capture", "progress"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root, evidence = Path(temporary) / "source", Path(temporary) / "evidence"
                root.mkdir(); evidence.mkdir()
                outside = Path(temporary) / "outside"
                outside.write_bytes(b"\x89PNG\r\n\x1a\npolicy-test-only" if kind == "capture" else b'{}')
                name = "personal-initial-image.png" if kind == "capture" else "personal-initial-progress.json"
                (root / name).symlink_to(outside)
                with self.assertRaises(AssertionError):
                    package.preserve_incomplete_smoke(root, evidence, "initial", "timeout", "a" * 40, "b" * 40)
                self.assertFalse((evidence / name).exists())

    def test_timeout_sampling_is_bounded_and_its_failure_remains_diagnostic(self):
        with tempfile.TemporaryDirectory() as temporary:
            evidence = Path(temporary)
            with mock.patch.object(package.subprocess, "run", side_effect=package.subprocess.TimeoutExpired("sample", 5)) as run:
                package.sample_smoke_timeout(12345, evidence, "initial")
            self.assertEqual(run.call_args.args[0][:3], ["sample", "12345", "1"])
            self.assertEqual(run.call_args.kwargs["timeout"], 5)
            self.assertIn("sampling failed", (evidence / "personal-initial-timeout-sample.txt").read_text())

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
                       system="macOS fixture", filesReadable=True, fileGitStates={"note.txt": "untracked", "README.md": "untracked"}, scenario="toolbar-sidebar-two-sessions-files")
                  for language in ["en", "zh-Hans"] for appearance in ["dark", "light"] for width in [1100, 640]]
        fixture = json.loads((Path(__file__).parents[1] / "shared/fixtures/client-ui-parity.json").read_text())
        settings = [dict(scene, section=section["id"], sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40,
                         draftUnchanged=True, navigationControlActivated=True, javaFixtureMatched=section["id"] == "java",
                         screenshot=f"personal-{phase}-settings-{section['id']}-{scene['language']}-{scene['appearance']}-{scene['width']}.png")
                    for section in fixture["settingsSections"] for scene in fixture["settingsScenes"]]
        pdf = [dict(scene, scenario="pdf-highlights", screenshot=f"personal-{phase}-pdf-highlights-{scene['language']}-{scene['appearance']}-{scene['width']}.png",
                    sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, platform="macOS", architecture="arm64", system="policy fixture",
                    pdfSHA256=fixture["pdf"]["sha256"], markID=fixture["pdf"]["mark"]["id"], marksCount=1, fixtureSessionCount=1, filesFolderExpanded=True, actualRemoveButton=True, reopenedRestoredMarks=True,
                    originalPdfUnchanged=True, inMainWorkspace=True, settingsPreserveDocument=True, nativePointerDrawAndDelete=True) for scene in fixture["contentScenes"]]
        quick = [dict(scene, scenario="quick-ssh-invalid", screenshot=f"personal-{phase}-quick-ssh-invalid-{scene['language']}-{scene['appearance']}-{scene['width']}.png",
                      sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, platform="macOS", architecture="arm64", system="policy fixture",
                      inputAddress=fixture["quickAddress"], terminalFixtureMarker=fixture["marker"], invalidInputRejected=True, addressRetained=True,
                      savedWorkspaceUnchanged=True, sameMainWindow=True, terminalGenerationRetained=True, actualSidebarButton=True, actualCancelPreservedState=True,
                      workspaceVisibleAroundDialog=True, modalWidth=540, modalHeight=300, modalLeft=(scene["width"]-540)/2, modalTop=(scene["height"]-300)/2)
                 for scene in fixture["quickScenes"]]
        github = [dict(scene, scenario="github-pr-draft", screenshot=f"personal-{phase}-github-pr-draft-{scene['language']}-{scene['appearance']}-{scene['width']}.png",
                       sourceHeadSHA="a"*40, testedMergeSHA="b"*40, platform="macOS", architecture="arm64", system="policy fixture", form=fixture["github"],
                       actualToolsSwitcher=True, actualEnabledToolsSwitcher=True, literalInputRetained=True, readableFields=True, workspaceVisibleAroundDialog=True, terminalGenerationRetained=True, savedWorkspaceUnchanged=True,
                       isolatedSimulatedCLI=True, noGitHubWrites=True, actualCancelPreservedState=True, modalWidth=min(640,scene["width"]*.92), modalHeight=500,
                       modalLeft=(scene["width"]-min(640,scene["width"]*.92))/2, modalTop=(scene["height"]-500)/2) for scene in fixture["githubScenes"]]
        return dict(nativeProjectMenuRevisionAndWorkspaceMove=dict(passed=True, dragSimulation=dict(passed=True, actualNSTableViewCallbacks=True, ownedPasteboard=True, foreignSourceRejected=True, forgedPayloadRejected=True, cancelledDragRejected=True, staleRevisionRejected=True, freshDropAndReverseVerified=True), actualMenuActions=True, stalePinRejected=True, staleMoveRejected=True, peerSettingRetained=True, terminalGenerationsAndViewsRetained=True, splitLayoutRetainedInReopenedSnapshot=True, movedAndReturned=True, sourceHeadSHA="a"*40, testedMergeSHA="b"*40, platform="macOS", architecture="arm64", system="policy fixture", screenshot=f"personal-{phase}-project-workspace-move.png"), nativeSidebarSessionClose=dict(passed=True, actualKeyboardFocusVisible=True, actualSpaceClosedBackgroundSession=True, selectedGenerationRetained=True, targetSessionID="background", selectedSessionID="foreground", screenshot=f"personal-{phase}-sidebar-close-background.png", sourceHeadSHA="a"*40, testedMergeSHA="b"*40, platform="macOS", architecture="arm64", system="policy fixture", width=640, height=720), githubPRScenes=github, quickSSHScenes=quick, contentScenes=pdf, pdfHighlightsNativeDrawDeleteReopenAndScopeVerified=True, pdfMarkWrongRootAndPathRejected=True, pdfHighlightsRetainedAfterReplacement=phase == "replacement", nativeSidebarSectionOrderAndReadOnlyCollapse=True, backgroundTabCloseRetainedSelectedGeneration=True, nativeProjectMenuPinCollapseOrderAndConflictVerified=True, workspaceScenes=scenes,
                    settingsScenes=settings, nativeTerminalControls=dict(generationBeforeRestart="old-generation", restartedGeneration="new-generation", searchInputBytesBefore=0, searchInputBytesAfter=0, passed=True, actualFontButtonsAppliedAndRestored=True, fontWritesRemainAvailableDuringFileRefresh=True, fontBoundsDisabled=True, unicodeCaseCountsAndNavigation=True, keyboardOpenAndEscape=True, keyboardShiftFindRoutesProjectSearch=True, searchInputDidNotReachPTY=True, terminalIdentityAndGenerationRetained=True, explicitRestartRetainedDescriptorAndView=True, sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, platform="macOS", architecture="arm64", system="policy fixture", width=640, height=720, screenshot=f"personal-{phase}-terminal-search.png"), embeddedWorkspaceFiles=dict(passed=True, tabControlsActivated=True, fontShortcutsTargetEditor=True, findShortcutRetainsEditorAndTerminal=True, arrowNavigationActivated=True, sameMainWindow=True, orderedAndReused=True, exactUnsavedDraftRetained=True, cancelCloseRetainedTabs=True, discardPreservedSiblingAndExternalWriter=True, terminalViewAndGenerationRetained=True, sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, platform="macOS", architecture="arm64", system="policy fixture", width=640, height=720, screenshot=f"personal-{phase}-embedded-files.png"), captures=[scene["screenshot"] for scene in scenes + settings + pdf + quick + github] + [f"personal-{phase}-project-workspace-move.png", f"personal-{phase}-sidebar-close-background.png", f"personal-{phase}-embedded-files.png", f"personal-{phase}-terminal-search.png"])

    def test_sidebar_close_requires_real_control_and_background_target_proof(self):
        import copy
        report = self.workspace_evidence("initial")
        package.validate_sidebar_close(report,"a"*40,"b"*40,"initial")
        for key,value in [("actualSpaceClosedBackgroundSession",False),("actualKeyboardFocusVisible",False),("selectedGenerationRetained",False),("sourceHeadSHA","c"*40),("targetSessionID","foreground"),("screenshot","old.png")]:
            wrong=copy.deepcopy(report);wrong["nativeSidebarSessionClose"][key]=value
            with self.subTest(key=key), self.assertRaises(AssertionError): package.validate_sidebar_close(wrong,"a"*40,"b"*40,"initial")

    def test_pr_requires_bounded_current_modal_and_no_api_writes(self):
        report = self.workspace_evidence("initial")
        package.validate_github_scenes(report, "a"*40, "b"*40, "initial")
        import copy
        for key,value in [("actualEnabledToolsSwitcher",False),("actualEnabledToolsSwitcher",None),("sourceHeadSHA","c"*40),("modalWidth",128),("noGitHubWrites",False),("readableFields",False),("form",{})]:
            wrong=copy.deepcopy(report);wrong["githubPRScenes"][0][key]=value
            with self.subTest(key=key), self.assertRaises(AssertionError): package.validate_github_scenes(wrong,"a"*40,"b"*40,"initial")
        for rows in [[],report["githubPRScenes"][1:],[report["githubPRScenes"][0]]*2]:
            wrong=copy.deepcopy(report);wrong["githubPRScenes"]=rows
            with self.assertRaises(AssertionError): package.validate_github_scenes(wrong,"a"*40,"b"*40,"initial")

    def test_quick_ssh_proof_requires_current_embedded_modal_and_preserved_data(self):
        changes = [("sourceHeadSHA", "c" * 40), ("testedMergeSHA", "c" * 40), ("inputAddress", "different"), ("terminalFixtureMarker", "old"), ("screenshot", "old.png")]
        changes += [(key, False) for key in ["invalidInputRejected", "addressRetained", "savedWorkspaceUnchanged", "sameMainWindow", "terminalGenerationRetained", "actualSidebarButton", "actualCancelPreservedState", "workspaceVisibleAroundDialog"]]
        changes += [("modalWidth", 1100), ("modalHeight", 720), ("modalTop", None), ("modalLeft", float("inf"))]
        for key, value in changes:
            report = self.workspace_evidence("initial"); report["quickSSHScenes"][0][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError): package.validate_quick_scenes(report, "a" * 40, "b" * 40, "initial")
        for kind in ["missing", "duplicate"]:
            report = self.workspace_evidence("initial")
            if kind == "missing": report["quickSSHScenes"].pop()
            else: report["quickSSHScenes"][0] = report["quickSSHScenes"][1]
            with self.subTest(kind=kind), self.assertRaises(AssertionError): package.validate_quick_scenes(report, "a" * 40, "b" * 40, "initial")

    def test_pdf_proof_rejects_missing_stale_or_unexecuted_operations(self):
        for key, value in [("sourceHeadSHA", "c" * 40), ("pdfSHA256", "0" * 64), ("markID", "old"), ("marksCount", 0), ("fixtureSessionCount", 2), ("filesFolderExpanded", False),
                           ("actualRemoveButton", False), ("reopenedRestoredMarks", False), ("originalPdfUnchanged", False), ("inMainWorkspace", False),
                           ("settingsPreserveDocument", False), ("nativePointerDrawAndDelete", False), ("screenshot", "old.png")]:
            report = self.workspace_evidence("initial")
            report["contentScenes"][0][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError): package.validate_pdf_scenes(report, "a" * 40, "b" * 40, "initial")
        for kind in ["missing", "duplicate", "scope", "pointer", "replacement"]:
            report = self.workspace_evidence("replacement")
            if kind == "missing": report["contentScenes"].pop()
            if kind == "duplicate": report["contentScenes"][0] = report["contentScenes"][1]
            if kind == "scope": report["pdfMarkWrongRootAndPathRejected"] = False
            if kind == "pointer": report["pdfHighlightsNativeDrawDeleteReopenAndScopeVerified"] = False
            if kind == "replacement": report["pdfHighlightsRetainedAfterReplacement"] = False
            with self.subTest(kind=kind), self.assertRaises(AssertionError): package.validate_pdf_scenes(report, "a" * 40, "b" * 40, "replacement")

    def test_terminal_controls_require_actual_input_and_current_source(self):
        for key, value in [("fontWritesRemainAvailableDuringFileRefresh", False), ("keyboardShiftFindRoutesProjectSearch", False), ("unicodeCaseCountsAndNavigation", False), ("searchInputDidNotReachPTY", False), ("terminalIdentityAndGenerationRetained", False), ("sourceHeadSHA", "c" * 40), ("screenshot", "old.png")]:
            report = self.workspace_evidence("initial")
            report["nativeTerminalControls"][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError): package.validate_terminal_controls(report, "a" * 40, "b" * 40, "initial")
        report = self.workspace_evidence("initial")
        report.pop("nativeTerminalControls")
        with self.assertRaises(AssertionError): package.validate_terminal_controls(report, "a" * 40, "b" * 40, "initial")

    def test_embedded_workspace_requires_actual_controls_and_current_source(self):
        for key, value in [("tabControlsActivated", False), ("fontShortcutsTargetEditor", False), ("findShortcutRetainsEditorAndTerminal", False), ("arrowNavigationActivated", False), ("terminalViewAndGenerationRetained", False), ("sourceHeadSHA", "c" * 40), ("screenshot", "old.png")]:
            report = self.workspace_evidence("initial")
            report["embeddedWorkspaceFiles"][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError): package.validate_embedded_workspace(report, "a" * 40, "b" * 40, "initial")
        report = self.workspace_evidence("initial")
        report.pop("embeddedWorkspaceFiles")
        with self.assertRaises(AssertionError): package.validate_embedded_workspace(report, "a" * 40, "b" * 40, "initial")

    def test_settings_navigation_evidence_rejects_missing_stale_or_changed_drafts(self):
        for mutation in ["missing", "duplicate", "source", "draft", "navigation", "height"]:
            report = self.workspace_evidence("initial")
            if mutation == "missing": report["settingsScenes"].pop()
            if mutation == "duplicate": report["settingsScenes"][0] = report["settingsScenes"][1]
            if mutation == "source": report["settingsScenes"][0]["testedMergeSHA"] = "c" * 40
            if mutation == "draft": report["settingsScenes"][0]["draftUnchanged"] = False
            if mutation == "navigation": report["settingsScenes"][0]["navigationControlActivated"] = False
            if mutation == "height": report["settingsScenes"][0]["height"] = 639
            with self.subTest(mutation=mutation), self.assertRaises(AssertionError):
                package.validate_settings_scenes(report, "a" * 40, "b" * 40, "initial")

    def test_workspace_acceptance_rejects_missing_duplicate_or_wrong_source_screenshots(self):
        for mutation in ["missing", "duplicate", "source", "file", "background-close", "unreadable-files", "missing-git-states", "wrong-git-state", "sidebar-sections", "project-actions"]:
            report = self.workspace_evidence("initial")
            if mutation == "missing": report["workspaceScenes"].pop()
            if mutation == "duplicate": report["workspaceScenes"][0] = report["workspaceScenes"][1]
            if mutation == "source": report["workspaceScenes"][0]["testedMergeSHA"] = "c" * 40
            if mutation == "file": report["captures"].remove(report["workspaceScenes"][0]["screenshot"])
            if mutation == "sidebar-sections": report["nativeSidebarSectionOrderAndReadOnlyCollapse"] = False
            if mutation == "background-close": report["backgroundTabCloseRetainedSelectedGeneration"] = False
            if mutation == "unreadable-files": report["workspaceScenes"][0]["filesReadable"] = False
            if mutation == "missing-git-states": report["workspaceScenes"][0].pop("fileGitStates")
            if mutation == "wrong-git-state": report["workspaceScenes"][0]["fileGitStates"]["note.txt"] = "modified"
            if mutation == "project-actions": report["nativeProjectMenuPinCollapseOrderAndConflictVerified"] = False
            with self.subTest(mutation=mutation), self.assertRaises(AssertionError):
                package.validate_workspace_scenes(report, "a" * 40, "b" * 40, "initial")

    def test_project_menu_evidence_rejects_stale_or_missing_native_operations(self):
        valid = self.workspace_evidence("initial")
        package.validate_workspace_scenes(valid, "a" * 40, "b" * 40, "initial")
        for mutation in ["missing", "stalePinRejected", "staleMoveRejected", "terminalGenerationsAndViewsRetained", "splitLayoutRetainedInReopenedSnapshot", "source", "file"]:
            report = self.workspace_evidence("initial")
            proof = report["nativeProjectMenuRevisionAndWorkspaceMove"]
            if mutation == "missing": report.pop("nativeProjectMenuRevisionAndWorkspaceMove")
            elif mutation == "source": proof["testedMergeSHA"] = "c" * 40
            elif mutation == "file": report["captures"].remove(proof["screenshot"])
            else: proof[mutation] = False
            with self.subTest(mutation=mutation), self.assertRaises(AssertionError):
                package.validate_workspace_scenes(report, "a" * 40, "b" * 40, "initial")

    def test_drag_simulation_requires_native_callbacks_and_all_failure_modes(self):
        for key in ["actualNSTableViewCallbacks", "ownedPasteboard", "foreignSourceRejected", "forgedPayloadRejected", "cancelledDragRejected", "staleRevisionRejected", "freshDropAndReverseVerified"]:
            report = self.workspace_evidence("initial")
            report["nativeProjectMenuRevisionAndWorkspaceMove"]["dragSimulation"][key] = False
            with self.subTest(key=key), self.assertRaises(AssertionError):
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
        report["inProgress"] = True
        with self.assertRaises(AssertionError):
            package.validate_smoke_report(report, "a" * 40, "b" * 40, "replacement")
        report["inProgress"] = False
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
