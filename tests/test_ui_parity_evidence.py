import copy
import hashlib
import importlib.util
import json
import struct
import tempfile
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
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
        chrome = self.fixture.parent.parent / "contracts/chrome-ui-v1.json"
        chrome_digest = hashlib.sha256(chrome.read_bytes()).hexdigest()
        font_digest = module.read_json(self.fixture.parents[2] / "src/assets/fonts/manifest.json")["files"]["CascadiaCode-Regular.ttf"]
        self.n = dict(passed=True, platform="macOS", architecture="arm64", system="Version 15.8.2",
                      sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, productionDataAccess=False,
                      uiParityFixtureSHA256=digest, backgroundTabCloseRetainedSelectedGeneration=True,
                      workspaceScenes=[], settingsScenes=[], contentScenes=[], quickSSHScenes=[], captures=[], pdfHighlightsNativeDrawDeleteReopenAndScopeVerified=True, pdfMarkWrongRootAndPathRejected=True)
        self.t = dict(passed=True, platform="darwin", architecture="arm64", productVersion="15.8.2",
                      head="a" * 40, tested="b" * 40, productionDataAccess=False, sourceTreeDirty=False,
                      uiParityFixtureSHA256=digest, scenes=[])
        for lang in fixture["languages"]:
            for appearance in fixture["appearances"]:
                for width in fixture["widths"]:
                    values = dict(language=lang, appearance=appearance, width=width, height=720,
                                  sidebarRailLeft=0, sidebarRailWidth=48, sidebarAllButtonLeft=7, sidebarAllButtonTop=52, sidebarAllButtonWidth=34, sidebarAllButtonHeight=34,
                                  terminalInsetLeft=11, terminalInsetRight=11, terminalInsetBottom=11, terminalHeaderTop=11, terminalHeaderHeight=35, terminalViewportGap=12,
                                  inspectorTop=0, inspectorHeight=720, inspectorHeaderTop=0, inspectorFooterBottom=720, inspectorViewportHeight=720,
                                  sidebarRowHeight=32, sidebarSectionHeight=32, sidebarSectionGap=18, sidebarListTop=8,
                                  fontFamily="Cascadia Code", fontFace="CascadiaCode-Regular", fontSourceSHA256=font_digest, fontCharacterWidth=9.96,
                                  terminalRenderer=dict(columns=40, rows=24, proposedColumns=40, proposedRows=24, viewportWidth=400, viewportHeight=600, backingScale=2, cellWidth=10, cellHeight=25),
                                  scenario="toolbar-sidebar-two-sessions-files", branchPicker=dict(name=fixture["github"]["head"], fontSize=11, captionGap=5, width=115, height=24, actualAppKitControl=True, actualDOMControl=True, fontName="policy fixture"), fileGitStates={path: "untracked" for path in fixture["files"]}, sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40,
                                  chromeContractSHA256=chrome_digest, toolbarHeight=44, toolbarTop=0, sidebarWidth=min(248, max(180, min(320, width * .3))), inspectorWidth=298.2 if width == 1100 else 128, generationRetained=True, filesReadable=True, fontSize=17, projectName=fixture["projectName"], workspaceName=fixture["workspaceName"])
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
        from tests.run_panel_parity_fixtures import policy_scenes
        self.n["runPanelScenes"] = policy_scenes(fixture, "initial", "a"*40, "b"*40, self.n["system"])
        self.n["runPanelActualFileCloseAndHideVerified"] = True
        for row in self.n["runPanelScenes"]:
            name = f"run-{row['kind']}-{row['state']}-{row['language']}-{row['appearance']}-{row['width']}"
            native, tauri = row["screenshot"], f"ui-parity-{name}.png"
            image = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", row["width"], row["height"]) + bytes(1100)
            (self.native / native).write_bytes(image); (self.tauri / tauri).write_bytes(image)
            self.n["captures"].append(native)
            self.t["scenes"].append(dict(scenario=name, checks=copy.deepcopy(row), screenshot=tauri))
        from tests.run_panel_parity_fixtures import policy_forms
        self.n["runPanelFormProof"] = policy_forms(fixture, "initial", "a"*40, "b"*40, self.n["system"])
        for row in self.n["runPanelFormProof"]:
            image = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", row["width"], row["height"]) + bytes(1100)
            (self.native / row["screenshot"]).write_bytes(image)
            self.n["captures"].append(row["screenshot"])
            name = f"run-form-{row['kind']}-{row['language']}-{row['appearance']}-{row['width']}"
            tauri = f"ui-parity-{name}.png"
            (self.tauri / tauri).write_bytes(image)
            self.t['scenes'].append(dict(scenario=name, screenshot=tauri, checks=dict(row)))
        cleanup = "ui-parity-run-panels-complete.png"
        (self.tauri / cleanup).write_bytes(image)
        self.t["scenes"].append(dict(scenario="run-panels-complete", screenshot=cleanup, checks=dict(passed=True, actualFileCloseAndHideVerified=True, terminalGenerationRetained=True, canonicalWorkspaceRetained=True)))
        for scene in fixture["settingsScenes"]:
            for section in fixture["settingsSections"]:
                values = dict(scene, section=section["id"], navigationControlActivated=True, draftUnchanged=True, automaticUpdates=fixture["automaticUpdates"], mavenFixtureMatched=section["id"] == "maven", databaseFixtureMatched=section["id"] == "database", javaFixtureMatched=section["id"] == "java")
                card_width, card_height = min(760, scene["width"] * 0.94), min(scene["height"] * 0.88, 75 + min(520, scene["height"] * 0.72))
                values.update(workspaceModal=True, settingsCard=dict(x=(scene["width"] - card_width) / 2, y=(scene["height"] - card_height) / 2, width=card_width, height=card_height))
                name = f"settings-{section['id']}-{scene['language']}-{scene['appearance']}-{scene['width']}"
                native, tauri = f"personal-initial-{name}.png", f"ui-parity-{name}.png"
                image = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", scene["width"], scene["height"]) + bytes(1100)
                (self.native / native).write_bytes(image)
                (self.tauri / tauri).write_bytes(image)
                self.n["settingsScenes"].append(dict(values, screenshot=native, sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40,
                                                    platform="macOS", architecture="arm64", system=self.n["system"]))
                self.n["captures"].append(native)
                self.t["scenes"].append(dict(scenario=name, checks=copy.deepcopy(values), screenshot=tauri))
        for scene in fixture["contentScenes"]:
            values = dict(scene, passed=True, fixtureSessionCount=1, filesFolderExpanded=True, pdfSHA256=fixture["pdf"]["sha256"], markID=fixture["pdf"]["mark"]["id"], marksCount=1,
                          actualRemoveButton=True, reopenedRestoredMarks=True, originalPdfUnchanged=True, inMainWorkspace=True, settingsPreserveDocument=True)
            name = f"pdf-highlights-{scene['language']}-{scene['appearance']}-{scene['width']}"
            native, tauri = f"personal-initial-{name}.png", f"ui-parity-{name}.png"
            image = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", scene["width"], scene["height"]) + bytes(1100)
            (self.native / native).write_bytes(image)
            (self.tauri / tauri).write_bytes(image)
            self.n["contentScenes"].append(dict(values, scenario="pdf-highlights", screenshot=native, sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40,
                                                platform="macOS", architecture="arm64", system=self.n["system"], nativePointerDrawAndDelete=True))
            self.n["captures"].append(native)
            self.t["scenes"].append(dict(scenario=name, checks=values, screenshot=tauri))
        for scene in fixture["quickScenes"]:
            values = dict(scene, passed=True, inputAddress=fixture["quickAddress"], terminalFixtureMarker=fixture["marker"],
                          invalidInputRejected=True, addressRetained=True, savedWorkspaceUnchanged=True, sameMainWindow=True,
                          terminalGenerationRetained=True, actualSidebarButton=True, actualCancelPreservedState=True,
                          workspaceVisibleAroundDialog=True, modalWidth=540, modalHeight=300, modalLeft=(scene["width"]-540)/2, modalTop=(scene["height"]-300)/2)
            name = f"quick-ssh-invalid-{scene['language']}-{scene['appearance']}-{scene['width']}"
            native, tauri = f"personal-initial-{name}.png", f"ui-parity-{name}.png"
            image = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", scene["width"], scene["height"]) + bytes(1100)
            (self.native / native).write_bytes(image); (self.tauri / tauri).write_bytes(image)
            self.n["quickSSHScenes"].append(dict(values, scenario="quick-ssh-invalid", screenshot=native,
                                                sourceHeadSHA="a" * 40, testedMergeSHA="b" * 40, platform="macOS", architecture="arm64", system=self.n["system"]))
            self.n["captures"].append(native)
            self.t["scenes"].append(dict(scenario=name, checks=values, screenshot=tauri))
        self.n["githubPRScenes"] = []
        for scene in fixture["githubScenes"]:
            width = min(640, scene["width"]*.92)
            values = dict(scene, passed=True, form=fixture["github"], actualToolsSwitcher=True, literalInputRetained=True, readableFields=True,
                          workspaceVisibleAroundDialog=True, terminalGenerationRetained=True, savedWorkspaceUnchanged=True,
                          isolatedSimulatedCLI=True, noGitHubWrites=True, actualCancelPreservedState=True,
                          modalWidth=width, modalHeight=500, modalLeft=(scene["width"]-width)/2, modalTop=(scene["height"]-500)/2)
            name = f"github-pr-draft-{scene['language']}-{scene['appearance']}-{scene['width']}"
            native, tauri = f"personal-initial-{name}.png", f"ui-parity-{name}.png"
            image = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", scene["width"], scene["height"]) + bytes(1100)
            (self.native / native).write_bytes(image); (self.tauri / tauri).write_bytes(image)
            self.n["githubPRScenes"].append(dict(values, scenario="github-pr-draft", screenshot=native, sourceHeadSHA="a"*40, testedMergeSHA="b"*40, platform="macOS", architecture="arm64", system=self.n["system"]))
            self.n["captures"].append(native)
            self.t["scenes"].append(dict(scenario=name, checks=values, screenshot=tauri))
        restart = "ui-parity-terminal-restart.png"
        image = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", 1100, 720) + bytes(1100)
        (self.tauri / restart).write_bytes(image)
        self.t["scenes"].append(dict(scenario="terminal-restart", screenshot=restart, checks=dict(
            passed=True, actualRestartButton=True, parsedUnicodeOutput=True, canonicalWorkspaceRetained=True,
            terminalViewRetained=True, generationBeforeRestart="old-generation", restartedGeneration="new-generation")))

    def test_run_panels_reject_missing_duplicate_and_stale_controls(self):
        original = copy.deepcopy(self.n)
        for mutation in ["missing", "duplicate", "source", "file", "toolbar", "view"]:
            self.n = copy.deepcopy(original)
            if mutation == "missing": self.n["runPanelScenes"].pop()
            elif mutation == "duplicate": self.n["runPanelScenes"][0] = self.n["runPanelScenes"][1]
            else:
                key, value = {"source": ("sourceHeadSHA", "c"*40), "file": ("fileVisible", True), "toolbar": ("actualToolbarButton", False), "view": ("retainedPanelView", False)}[mutation]
                self.n["runPanelScenes"][0][key] = value
            with self.subTest(mutation=mutation), self.assertRaises(AssertionError): self.run_compare()

    def test_run_panels_require_matching_finite_actual_geometry_and_cleanup(self):
        original = copy.deepcopy(self.n)
        for key in ["panelLeft", "panelTop", "panelWidth", "panelHeight", "panelHeaderHeight"]:
            for value in [None, True, float("nan"), float("inf"), -1, original["runPanelScenes"][0][key] + 2]:
                self.n = copy.deepcopy(original); self.n["runPanelScenes"][0][key] = value
                with self.subTest(key=key, value=value), self.assertRaises(AssertionError): self.run_compare()
        self.n = copy.deepcopy(original); self.n["runPanelActualFileCloseAndHideVerified"] = False
        with self.assertRaises(AssertionError): self.run_compare()

    def test_pr_tool_width_and_missing_or_modified_operations_are_rejected(self):
        baseline = copy.deepcopy(self.n)
        for key, value in [("modalWidth",128), ("readableFields",False), ("noGitHubWrites",False), ("form",{}), ("modalLeft", float("nan"))]:
            with self.subTest(key=key):
                self.n=copy.deepcopy(baseline);self.n["githubPRScenes"][0][key]=value
                with self.assertRaises(AssertionError): self.run_compare()
        self.n=copy.deepcopy(baseline);self.n["githubPRScenes"].pop()
        with self.assertRaises(AssertionError): self.run_compare()

    def test_pr_centered_forms_with_different_heights_are_rejected(self):
        self.n["githubPRScenes"][0].update(modalHeight=502,modalTop=(720-502)/2)
        with self.assertRaises(AssertionError): self.run_compare()

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
        import xml.etree.ElementTree as ET
        self.assertEqual(ET.fromstring(fixture["files"]["pom.xml"]).findtext("artifactId"), "parity")
        compile(fixture["files"]["main.py"], "shared parity/main.py", "exec")

    def test_complete_pair_is_reviewable_but_does_not_claim_functional_parity(self):
        result = self.run_compare()
        self.assertTrue(result["comparisonReady"])
        self.assertFalse(result["functionalParityAccepted"])
        self.assertEqual(len(result["pairs"]), 54)
        self.assertEqual(len(list((self.root / "comparison").glob("*.png"))), 110)
        self.assertEqual(len(result['nativeRunFormEvidence']), 4)
        for proof in result['nativeRunFormEvidence']:
            original = (self.native / proof['screenshot']).read_bytes()
            self.assertEqual((self.root / 'comparison' / proof['screenshot']).read_bytes(), original)
            self.assertEqual(proof['SHA256'], hashlib.sha256(original).hexdigest())

    def test_run_forms_require_both_originals_and_matching_actual_literal_operations(self):
        baseline = copy.deepcopy(self.t)
        form = next(row for row in self.t['scenes'] if row['scenario'].startswith('run-form-'))
        for key, value in [('actualTextEditorInput', False), ('invalidArgumentRetainedWithoutWrite', False), ('literalArgumentsSaved', False), ('validArgumentTextRetained', False), ('temporaryEnvironmentRetainedWithoutPersistence', False), ('fixtureArguments', 'changed'), ('savedArguments', []), ('saveHeight', 80)]:
            self.t = copy.deepcopy(baseline)
            next(row for row in self.t['scenes'] if row['scenario'] == form['scenario'])['checks'][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError): self.run_compare()
        self.t = copy.deepcopy(baseline)
        self.t['scenes'] = [row for row in self.t['scenes'] if row['scenario'] != form['scenario']]
        with self.assertRaises(AssertionError): self.run_compare()
        self.t = copy.deepcopy(baseline); self.t['scenes'].append(copy.deepcopy(form))
        with self.assertRaises(AssertionError): self.run_compare()
        self.t = baseline
        (self.tauri / form['screenshot']).unlink()
        with self.assertRaises(FileNotFoundError): self.run_compare()

    def test_quick_ssh_requires_current_main_window_images_and_preserved_data(self):
        original_n, original_t = copy.deepcopy(self.n), copy.deepcopy(self.t)
        changes = [("sourceHeadSHA", "c" * 40), ("testedMergeSHA", "c" * 40), ("inputAddress", "different"), ("terminalFixtureMarker", "old"), ("screenshot", "old.png")]
        changes += [(key, False) for key in ["invalidInputRejected", "addressRetained", "savedWorkspaceUnchanged", "sameMainWindow", "terminalGenerationRetained", "actualSidebarButton", "actualCancelPreservedState", "workspaceVisibleAroundDialog"]]
        changes += [("modalWidth", 1100), ("modalHeight", 720), ("modalTop", None), ("modalLeft", float("nan"))]
        for key, value in changes:
            self.n, self.t = copy.deepcopy(original_n), copy.deepcopy(original_t)
            self.n["quickSSHScenes"][0][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError): self.run_compare()
        for kind in ["missing", "duplicate", "ordinary", "platform"]:
            self.n, self.t = copy.deepcopy(original_n), copy.deepcopy(original_t)
            if kind == "missing": self.n["quickSSHScenes"].pop()
            if kind == "duplicate": self.n["quickSSHScenes"][0] = self.n["quickSSHScenes"][1]
            if kind == "ordinary": next(row for row in self.t["scenes"] if row["scenario"].startswith("quick-ssh-invalid-"))["checks"]["sameMainWindow"] = False
            if kind == "platform": self.n["quickSSHScenes"][0]["platform"] = "browser"
            with self.subTest(kind=kind), self.assertRaises(AssertionError): self.run_compare()

    def test_quick_ssh_forms_must_have_the_same_actual_bounds(self):
        self.n["quickSSHScenes"][0].update(modalHeight=302, modalTop=209)
        with self.assertRaisesRegex(AssertionError, "Different actual Quick SSH geometry"):
            self.run_compare()

    def test_terminal_geometry_requires_matching_actual_insets_header_and_viewport_gap(self):
        original = copy.deepcopy(self.n)
        for key in ["terminalInsetLeft", "terminalInsetRight", "terminalInsetBottom", "terminalHeaderTop", "terminalHeaderHeight", "terminalViewportGap"]:
            for value in [None, True, float("nan"), float("inf"), -1, original["workspaceScenes"][0][key] + 12]:
                self.n = copy.deepcopy(original)
                self.n["workspaceScenes"][0][key] = value
                with self.subTest(key=key, value=value), self.assertRaises(AssertionError): self.run_compare()
        self.n = copy.deepcopy(original)
        self.n["workspaceScenes"][0].pop("terminalHeaderHeight")
        with self.assertRaises(AssertionError): self.run_compare()

    def test_renderer_metrics_require_real_grid_viewport_and_scale_on_both_clients(self):
        original_n, original_t = copy.deepcopy(self.n), copy.deepcopy(self.t)
        for side in ["native", "ordinary"]:
            for key in ["columns", "rows", "viewportWidth", "viewportHeight", "backingScale", "cellWidth", "cellHeight"]:
                for value in [None, True, 0, -1, float("nan"), float("inf")]:
                    self.n, self.t = copy.deepcopy(original_n), copy.deepcopy(original_t)
                    scene = self.n["workspaceScenes"][0] if side == "native" else self.t["scenes"][0]["checks"]
                    scene["terminalRenderer"] = {**scene["terminalRenderer"], key: value}
                    with self.subTest(side=side, key=key, value=value), self.assertRaises(AssertionError): self.run_compare()
        self.n, self.t = copy.deepcopy(original_n), copy.deepcopy(original_t)
        scene = self.n["workspaceScenes"][0]
        scene["terminalRenderer"] = dict(columns=39, rows=23, proposedColumns=39, proposedRows=23, viewportWidth=400, viewportHeight=600, backingScale=2, cellWidth=10, cellHeight=25)
        result = self.run_compare()
        pair = next(pair for pair in result["pairs"] if pair["area"] == "workspace" and all(pair[key] == scene[key] for key in ["width", "language", "appearance"]))
        self.assertEqual(pair["terminalRenderer"]["native"]["columns"], 39)
        self.assertEqual(pair["terminalRenderer"]["tauri"]["columns"], 40)
        self.assertFalse(result["functionalParityAccepted"])

    def test_unfitted_renderer_cannot_pass_as_a_settled_capture(self):
        original_n, original_t = copy.deepcopy(self.n), copy.deepcopy(self.t)
        for side in ["native", "ordinary"]:
            for key in ["proposedColumns", "proposedRows"]:
                for value in [None, True, 0, 1, 40.0, float("nan")]:
                    self.n, self.t = copy.deepcopy(original_n), copy.deepcopy(original_t)
                    scene = self.n["workspaceScenes"][0] if side == "native" else self.t["scenes"][0]["checks"]
                    scene["terminalRenderer"] = {**scene["terminalRenderer"], key: value}
                    with self.subTest(side=side, key=key, value=value), self.assertRaises(AssertionError): self.run_compare()

    def test_navigation_cannot_pass_from_outer_sidebar_width_while_the_rail_is_clipped(self):
        original_n, original_t = copy.deepcopy(self.n), copy.deepcopy(self.t)
        for side in ["native", "ordinary"]:
            for key in ["sidebarRailLeft", "sidebarRailWidth", "sidebarAllButtonLeft", "sidebarAllButtonTop", "sidebarAllButtonWidth", "sidebarAllButtonHeight"]:
                for value in [None, True, float("nan"), -24]:
                    self.n, self.t = copy.deepcopy(original_n), copy.deepcopy(original_t)
                    scene = self.n["workspaceScenes"][0] if side == "native" else self.t["scenes"][0]["checks"]
                    scene[key] = value
                    with self.subTest(side=side, key=key, value=value), self.assertRaises(AssertionError): self.run_compare()

    def test_pdf_requires_current_images_matching_data_and_actual_operations(self):
        original_n, original_t = copy.deepcopy(self.n), copy.deepcopy(self.t)
        mutations = [("sourceHeadSHA", "c" * 40), ("pdfSHA256", "0" * 64), ("markID", "old"), ("marksCount", 0), ("fixtureSessionCount", 2), ("filesFolderExpanded", False),
                     ("actualRemoveButton", False), ("reopenedRestoredMarks", False), ("originalPdfUnchanged", False),
                     ("inMainWorkspace", False), ("settingsPreserveDocument", False), ("nativePointerDrawAndDelete", False), ("screenshot", "old.png")]
        for key, value in mutations:
            self.n, self.t = copy.deepcopy(original_n), copy.deepcopy(original_t)
            self.n["contentScenes"][0][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError): self.run_compare()
        for kind in ["missing", "duplicate", "ordinary", "scope", "pointer"]:
            self.n, self.t = copy.deepcopy(original_n), copy.deepcopy(original_t)
            if kind == "missing": self.n["contentScenes"].pop()
            if kind == "duplicate": self.n["contentScenes"][0] = self.n["contentScenes"][1]
            if kind == "ordinary": next(row for row in self.t["scenes"] if row["scenario"].startswith("pdf-highlights-"))["checks"]["actualRemoveButton"] = False
            if kind == "scope": self.n["pdfMarkWrongRootAndPathRejected"] = False
            if kind == "pointer": self.n["pdfHighlightsNativeDrawDeleteReopenAndScopeVerified"] = False
            with self.subTest(kind=kind), self.assertRaises(AssertionError): self.run_compare()

    def test_restart_requires_unique_actual_operation_new_generation_and_screenshot(self):
        original = copy.deepcopy(self.t["scenes"])
        for mutation in ["missing", "duplicate", "button", "output", "workspace", "view", "generation", "screenshot"]:
            self.t["scenes"] = copy.deepcopy(original)
            restart = self.t["scenes"][-1]
            if mutation == "missing": self.t["scenes"].pop()
            if mutation == "duplicate": self.t["scenes"].append(copy.deepcopy(restart))
            for name, key in [("button", "actualRestartButton"), ("output", "parsedUnicodeOutput"), ("workspace", "canonicalWorkspaceRetained"), ("view", "terminalViewRetained")]:
                if mutation == name: restart["checks"][key] = False
            if mutation == "generation": restart["checks"]["restartedGeneration"] = restart["checks"]["generationBeforeRestart"]
            if mutation == "screenshot": restart["screenshot"] = "absent.png"
            with self.subTest(mutation=mutation), self.assertRaises(AssertionError): self.run_compare()

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

    def test_settings_require_workspace_modals_and_matching_actual_card_bounds(self):
        original_native, original_tauri = copy.deepcopy(self.n), copy.deepcopy(self.t)
        mutations = [("workspaceModal", False), ("settingsCard", {}), ("x", -1), ("y", float("nan")), ("width", 900), ("height", 0), ("width", 759), ("height", 500)]
        for side in ["native", "tauri"]:
            for key, value in mutations:
                self.n, self.t = copy.deepcopy(original_native), copy.deepcopy(original_tauri)
                scene = self.n["settingsScenes"][0] if side == "native" else next(scene["checks"] for scene in self.t["scenes"] if scene["scenario"].startswith("settings-"))
                if key in ["workspaceModal", "settingsCard"]: scene[key] = value
                else: scene["settingsCard"][key] = value
                with self.subTest(side=side, key=key, value=value), self.assertRaises(AssertionError): self.run_compare()

    def test_rejects_stale_sources_failed_runs_wrong_architecture_and_different_fixtures(self):
        for key, value in [("tested", "c" * 40), ("head", "c" * 40), ("passed", False),
                           ("architecture", "x64"), ("productionDataAccess", True), ("sourceTreeDirty", True),
                           ("uiParityFixtureSHA256", "0" * 64), ("productVersion", "15.7.9")]:
            original = copy.deepcopy(self.t)
            self.t[key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                self.run_compare()
            self.t = original

    def test_rejects_different_chrome_and_old_toolbar_geometry(self):
        original = copy.deepcopy(self.t["scenes"][0]["checks"])
        for key, value in [("chromeContractSHA256", "0" * 64), ("sidebarRowHeight", 28), ("sidebarSectionHeight", 28), ("sidebarSectionGap", 2), ("sidebarListTop", 0), ("toolbarTop", 28), ("toolbarHeight", 40), ("inspectorWidth", 420), ("sidebarWidth", 320), ("toolbarHeight", 0)]:
            self.t["scenes"][0]["checks"] = {**original, key: value}
            with self.subTest(key=key, value=value), self.assertRaises(AssertionError): self.run_compare()
        self.t["scenes"][0]["checks"] = original
        self.n["workspaceScenes"][0].pop("chromeContractSHA256")
        with self.assertRaises(AssertionError): self.run_compare()

    def test_rejects_offset_short_clipped_or_missing_native_and_ordinary_tools_geometry(self):
        for scene in [self.n["workspaceScenes"][0], self.t["scenes"][0]["checks"]]:
            original = copy.deepcopy(scene)
            for key in ["inspectorTop", "inspectorHeight", "inspectorHeaderTop", "inspectorFooterBottom", "inspectorViewportHeight"]:
                for value in [None, float("nan"), original[key] + 44]:
                    scene[key] = value
                    with self.subTest(key=key, value=value), self.assertRaises(AssertionError): self.run_compare()
                scene.clear()
                scene.update(original)

    def test_rejects_missing_and_duplicate_scene_records(self):
        original = copy.deepcopy(self.n)
        self.n["workspaceScenes"].pop()
        with self.assertRaises(AssertionError): self.run_compare()
        self.n = original
        self.n["workspaceScenes"][0] = self.n["workspaceScenes"][1]
        with self.assertRaises(AssertionError): self.run_compare()

    def test_rejects_fallback_stale_or_differently_measured_fonts(self):
        original = copy.deepcopy(self.t["scenes"][0]["checks"])
        for key, value in [("fontFamily", "Courier"), ("fontFace", "Menlo-Regular"), ("fontSourceSHA256", "0" * 64), ("fontCharacterWidth", 10.4), ("fontCharacterWidth", None), ("fontCharacterWidth", float('nan'))]:
            self.t["scenes"][0]["checks"] = {**original, key: value}
            with self.subTest(key=key, value=value), self.assertRaises(AssertionError): self.run_compare()

    def test_rejects_missing_or_tiny_images(self):
        path = self.native / self.n["captures"][0]
        path.write_bytes(b"\x89PNG\r\n\x1a\n")
        with self.assertRaises(AssertionError): self.run_compare()
        path.unlink()
        with self.assertRaises(FileNotFoundError): self.run_compare()

    def test_rejects_missing_or_unmeasured_branch_picker_geometry(self):
        for side in ["native", "ordinary"]:
            for mutation in ["missing", "name", "fontSize", "captionGap", "height", "control"]:
                self.setUp()
                scene = self.n["workspaceScenes"][0] if side == "native" else self.t["scenes"][0]["checks"]
                if mutation == "missing": scene.pop("branchPicker")
                else:
                    scene["branchPicker"] = dict(scene["branchPicker"])
                    if mutation == "name": scene["branchPicker"]["name"] = "wrong-branch"
                    elif mutation == "control": scene["branchPicker"]["actualAppKitControl" if side == "native" else "actualDOMControl"] = False
                    else: scene["branchPicker"][mutation] = 44
                with self.subTest(side=side, mutation=mutation), self.assertRaises(AssertionError):
                    self.run_compare()

    def test_rejects_missing_incomplete_or_wrong_actual_file_git_states(self):
        for side in ["native", "tauri"]:
            scene = self.n["workspaceScenes"][0] if side == "native" else self.t["scenes"][0]["checks"]
            original = scene["fileGitStates"]
            try:
                for states in [None, {}, {"note.txt": "untracked"}, {"note.txt": "modified", "README.md": "untracked"}]:
                    scene["fileGitStates"] = states
                    with self.subTest(side=side, states=states), self.assertRaises(AssertionError): self.run_compare()
            finally:
                scene["fileGitStates"] = original

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

    def test_maven_loading_screens_cannot_replace_verified_controls(self):
        scene = next(scene for scene in self.n["settingsScenes"] if scene["section"] == "maven")
        scene["mavenFixtureMatched"] = False
        with self.assertRaises(AssertionError): self.run_compare()

    def test_java_loading_screens_cannot_replace_the_actual_catalog(self):
        scene = next(scene for scene in self.n["settingsScenes"] if scene["section"] == "java")
        scene["javaFixtureMatched"] = False
        with self.assertRaises(AssertionError): self.run_compare()

    def test_database_loading_screens_cannot_replace_the_actual_catalog(self):
        scene = next(scene for scene in self.n["settingsScenes"] if scene["section"] == "database")
        scene["databaseFixtureMatched"] = False
        with self.assertRaises(AssertionError): self.run_compare()


if __name__ == "__main__":
    unittest.main()
