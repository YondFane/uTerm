import importlib.util
import copy
import base64
import json
import plistlib
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
    def test_run_forms_require_actual_actions_current_sources_and_originals(self):
        fixture = json.loads((Path(__file__).parents[1] / "shared/fixtures/client-ui-parity.json").read_text())
        for phase in ["initial", "replacement"]:
            report = self.workspace_evidence(phase)
            package.validate_native_run_forms(report, fixture, "a"*40, "b"*40, phase)
            changes = [(key, False) for key in ["passed", "actualAdvancedToggle", "actualSaveButtonAndFeedback", "compactRightAlignedSave", "actualConfigurationCollapseAndRestore", "canonicalStateAndSessionRetained"]]
            changes += [("sourceHeadSHA", "c"*40), ("testedMergeSHA", "c"*40), ("architecture", "x86_64"), ("screenshot", "old.png")]
            for key, value in changes:
                wrong = copy.deepcopy(report); wrong["runPanelFormProof"][0][key] = value
                with self.subTest(phase=phase, key=key), self.assertRaises(AssertionError):
                    package.validate_native_run_forms(wrong, fixture, "a"*40, "b"*40, phase)

    def test_run_forms_reject_stretched_buttons_and_overlapping_or_missing_columns(self):
        fixture = json.loads((Path(__file__).parents[1] / "shared/fixtures/client-ui-parity.json").read_text())
        report = self.workspace_evidence("initial")
        for key, value in [("saveWidth", 300), ("saveHeight", 80), ("saveRightInset", 100), ("saveRightInset", -1), ("panelWidth", True), ("saveHeight", float("nan")),
                           ("fieldFrames", []), ("fieldFrames", [dict(id=name, left=12, top=20, width=84, height=40) for name in ["module", "mode", "version"]])]:
            wrong = copy.deepcopy(report); wrong["runPanelFormProof"][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(AssertionError):
                package.validate_native_run_forms(wrong, fixture, "a"*40, "b"*40, "initial")

    def test_run_forms_require_every_kind_language_and_window_once(self):
        fixture = json.loads((Path(__file__).parents[1] / "shared/fixtures/client-ui-parity.json").read_text())
        report = self.workspace_evidence("initial")
        for proofs in [[], report["runPanelFormProof"][:-1], [report["runPanelFormProof"][0]]*4]:
            with self.subTest(count=len(proofs)), self.assertRaises(AssertionError):
                package.validate_native_run_forms(dict(report, runPanelFormProof=proofs), fixture, "a"*40, "b"*40, "initial")

    def test_phase_timeout_kills_owned_app_and_retains_incomplete_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            evidence = Path(temporary) / "evidence"
            installed = Path(temporary) / "installed.app"
            root.mkdir(); evidence.mkdir(); (installed / "Contents").mkdir(parents=True)
            (installed / "Contents/Info.plist").write_bytes(plistlib.dumps(dict(UTermUpdateMode="manual")))
            progress = dict(passed=False, inProgress=True, stage="run-panel-grid", elapsedSeconds=299)
            (root / "personal-initial-progress.json").write_text(json.dumps(progress))
            name = "personal-initial-run-python.png"
            (root / name).write_bytes(b"\x89PNG\r\n\x1a\npolicy-test-only")
            process = mock.Mock(pid=12345)
            process.wait.side_effect = [package.subprocess.TimeoutExpired("uTerm", 300), 0]
            process.poll.return_value = None
            with mock.patch.object(package, "run", return_value=b"{}"), \
                 mock.patch.object(package.subprocess, "Popen", return_value=process), \
                 mock.patch.object(package, "sample_smoke_timeout") as sample:
                with self.assertRaises(package.subprocess.TimeoutExpired):
                    package.run_smoke(installed, installed, root, evidence, "a" * 40, "b" * 40, "https://example.invalid")
            self.assertEqual(process.wait.call_args_list, [mock.call(timeout=300), mock.call()])
            process.kill.assert_called_once_with()
            sample.assert_called_once_with(12345, evidence, "initial")
            report = json.loads((evidence / "personal-initial-incomplete.json").read_text())
            self.assertFalse(report["passed"])
            self.assertTrue(report["incomplete"])
            self.assertEqual(report["lastProgress"], progress)
            self.assertEqual(report["captures"], [name])
            self.assertIn("300-second", report["failure"])
            self.assertFalse((evidence / "personal-initial.json").exists())

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
        fixture = json.loads((Path(__file__).parents[1] / "shared/fixtures/client-ui-parity.json").read_text())
        scenes = [dict(language=language, appearance=appearance, width=width, height=720,
                       screenshot=f"personal-{phase}-workspace-{language}-{appearance}-{width}.png",
                       sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, platform="macOS", architecture="arm64",
                       system="macOS fixture", filesReadable=True, fileGitStates={path: "untracked" for path in fixture["files"]}, scenario="toolbar-sidebar-two-sessions-files", branchPicker=dict(name="qa-feature", fontSize=11, captionGap=5, width=115, height=24, actualAppKitControl=True, fontName="policy fixture"), windowControls=[dict(x=16+20*i, y=18, width=14, height=16) for i in range(3)])
                  for language in ["en", "zh-Hans"] for appearance in ["dark", "light"] for width in [1100, 640]]
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
                       actualToolsSwitcher=True, literalInputRetained=True, readableFields=True, workspaceVisibleAroundDialog=True, terminalGenerationRetained=True, savedWorkspaceUnchanged=True,
                       isolatedSimulatedCLI=True, noGitHubWrites=True, actualCancelPreservedState=True, modalWidth=min(640,scene["width"]*.92), modalHeight=500,
                       modalLeft=(scene["width"]-min(640,scene["width"]*.92))/2, modalTop=(scene["height"]-500)/2) for scene in fixture["githubScenes"]]
        from tests.run_panel_parity_fixtures import policy_scenes
        runs = policy_scenes(fixture, phase, "a"*40, "b"*40, "policy fixture")
        tools = [dict(scene, passed=True, actualManageToolsButton=True, busyStateInjectedForQA=True, busyActionRejected=True,
                      argumentDraftInjectedForQA=True, argumentDraftRetained=True, originPanelHiddenByQA=True, refreshCompletedWithOriginPanelHidden=True, actualRunToolbarRestore=True, actualSharedJavaCatalog=True, actualCloseControl=True,
                      projectDetectionCompletedAfterClose=True, runConfigurationAndPanelRetained=True, terminalGenerationRetained=True,
                      canonicalStateUnchanged=True, sourceHeadSHA="a"*40, testedMergeSHA="b"*40,
                      platform="macOS", architecture="arm64", system="policy fixture",
                      screenshot=f"personal-{phase}-java-tools-{scene['language']}-{scene['appearance']}-{scene['width']}.png")
                 for scene in fixture["runPanelScenes"]]

        from tests.run_panel_parity_fixtures import policy_forms
        forms = policy_forms(fixture, phase, "a"*40, "b"*40, "policy fixture")
        return dict(runPanelFormProof=forms, platform="macOS", architecture="arm64", system="policy fixture", runPanelJavaToolsProof=tools, runPanelScenes=runs, runPanelActualFileCloseAndHideVerified=True, nativeProjectMenuRevisionAndWorkspaceMove=dict(passed=True, dragSimulation=dict(passed=True, actualNSTableViewCallbacks=True, ownedPasteboard=True, foreignSourceRejected=True, forgedPayloadRejected=True, cancelledDragRejected=True, staleRevisionRejected=True, freshDropAndReverseVerified=True), actualMenuActions=True, stalePinRejected=True, staleMoveRejected=True, peerSettingRetained=True, terminalGenerationsAndViewsRetained=True, splitLayoutRetainedInReopenedSnapshot=True, movedAndReturned=True, sourceHeadSHA="a"*40, testedMergeSHA="b"*40, platform="macOS", architecture="arm64", system="policy fixture", screenshot=f"personal-{phase}-project-workspace-move.png"), nativeSidebarSessionClose=dict(passed=True, actualKeyboardFocusVisible=True, actualSpaceClosedBackgroundSession=True, selectedGenerationRetained=True, targetSessionID="background", selectedSessionID="foreground", screenshot=f"personal-{phase}-sidebar-close-background.png", sourceHeadSHA="a"*40, testedMergeSHA="b"*40, platform="macOS", architecture="arm64", system="policy fixture", width=640, height=720), githubPRScenes=github, quickSSHScenes=quick, contentScenes=pdf, pdfHighlightsNativeDrawDeleteReopenAndScopeVerified=True, pdfMarkWrongRootAndPathRejected=True, pdfHighlightsRetainedAfterReplacement=phase == "replacement", nativeSidebarSectionOrderAndReadOnlyCollapse=True, backgroundTabCloseRetainedSelectedGeneration=True, nativeProjectMenuPinCollapseOrderAndConflictVerified=True, workspaceScenes=scenes,
                    settingsScenes=settings, nativeTerminalControls=dict(generationBeforeRestart="old-generation", restartedGeneration="new-generation", searchInputBytesBefore=0, searchInputBytesAfter=0, passed=True, actualFontButtonsAppliedAndRestored=True, fontWritesRemainAvailableDuringFileRefresh=True, fontBoundsDisabled=True, unicodeCaseCountsAndNavigation=True, keyboardOpenAndEscape=True, keyboardShiftFindRoutesProjectSearch=True, searchInputDidNotReachPTY=True, terminalIdentityAndGenerationRetained=True, explicitRestartRetainedDescriptorAndView=True, sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, platform="macOS", architecture="arm64", system="policy fixture", width=640, height=720, screenshot=f"personal-{phase}-terminal-search.png"), embeddedWorkspaceFiles=dict(passed=True, tabControlsActivated=True, fontShortcutsTargetEditor=True, findShortcutRetainsEditorAndTerminal=True, arrowNavigationActivated=True, sameMainWindow=True, orderedAndReused=True, exactUnsavedDraftRetained=True, cancelCloseRetainedTabs=True, discardPreservedSiblingAndExternalWriter=True, terminalViewAndGenerationRetained=True, sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, platform="macOS", architecture="arm64", system="policy fixture", width=640, height=720, screenshot=f"personal-{phase}-embedded-files.png"), captures=[row["screenshot"] for row in forms] + [scene["screenshot"] for scene in scenes + settings + pdf + quick + github + runs + tools] + [f"personal-{phase}-project-workspace-move.png", f"personal-{phase}-sidebar-close-background.png", f"personal-{phase}-embedded-files.png", f"personal-{phase}-terminal-search.png"])

    def test_java_tools_requires_actual_route_refresh_and_retained_draft(self):
        import copy
        for phase in ["initial", "replacement"]:
            report = self.workspace_evidence(phase)
            package.validate_java_run_tools(report, "a"*40, "b"*40, phase)
            for key, value in [("actualManageToolsButton", False), ("busyActionRejected", False), ("argumentDraftRetained", False),
                               ("actualSharedJavaCatalog", False), ("projectDetectionCompletedAfterClose", False), ("originPanelHiddenByQA", False), ("refreshCompletedWithOriginPanelHidden", False), ("actualRunToolbarRestore", False),
                               ("terminalGenerationRetained", False), ("canonicalStateUnchanged", False),
                               ("sourceHeadSHA", "c"*40), ("testedMergeSHA", "c"*40), ("screenshot", "stale.png")]:
                wrong = copy.deepcopy(report); wrong["runPanelJavaToolsProof"][0][key] = value
                with self.subTest(phase=phase, key=key), self.assertRaises(AssertionError):
                    package.validate_java_run_tools(wrong, "a"*40, "b"*40, phase)
            for proofs in [[], report["runPanelJavaToolsProof"][:1], [report["runPanelJavaToolsProof"][0]]*2]:
                wrong = dict(report, runPanelJavaToolsProof=proofs)
                with self.subTest(phase=phase, proofs=proofs), self.assertRaises(AssertionError):
                    package.validate_java_run_tools(wrong, "a"*40, "b"*40, phase)

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
        for key,value in [("sourceHeadSHA","c"*40),("modalWidth",128),("noGitHubWrites",False),("readableFields",False),("form",{})]:
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

    def test_workspace_requires_all_shared_fixture_file_states(self):
        for phase in ["initial", "replacement"]:
            report = self.workspace_evidence(phase)
            package.validate_workspace_scenes(report, "a" * 40, "b" * 40, phase)
            scene = report["workspaceScenes"][0]
            original = scene["fileGitStates"]
            for path in ["pom.xml", "main.py"]:
                for states in [{key: value for key, value in original.items() if key != path},
                               dict(original, **{path: "modified"}), dict(original, unexpected="untracked")]:
                    with self.subTest(phase=phase, path=path, states=states), self.assertRaises(AssertionError):
                        scene["fileGitStates"] = states
                        package.validate_workspace_scenes(report, "a" * 40, "b" * 40, phase)
            scene["fileGitStates"] = original

    def test_workspace_chrome_requires_actual_branch_and_window_control_measurements(self):
        for mutation in ["branch", "font", "gap", "controls", "inset"]:
            report = self.workspace_evidence("initial")
            scene = report["workspaceScenes"][0]
            if mutation == "branch": scene.pop("branchPicker")
            elif mutation == "font": scene["branchPicker"]["fontSize"] = 13
            elif mutation == "gap": scene["branchPicker"]["captionGap"] = 40
            elif mutation == "controls": scene["windowControls"].pop()
            else: scene["windowControls"][0]["x"] = 8
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
