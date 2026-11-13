import importlib.util
import copy
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
    def reopened_reports(self):
        sessions = [{"id": "first", "generation": "generation-one"}, {"id": "second", "generation": "generation-two"}]
        layout = {"kind": "split", "axis": "horizontal", "sessions": ["first", "second"]}
        return ({"splitSessionCount": 2, "sessions": sessions, "persistedSplitLayout": layout},
                {"restoredTerminalViewsVisible": True, "replayed": True, "sessions": list(reversed(copy.deepcopy(sessions))), "restoredSplitLayout": copy.deepcopy(layout), "captures": ["native-reconnect-restored-layout.png"]})

    def test_real_relaunch_evidence_retains_exact_layout_generations_and_original_window(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            live, reopened = self.reopened_reports()
            name = "native-reconnect-restored-layout.png"
            with self.assertRaises(FileNotFoundError):
                matrix.restored_session_evidence(root, live, reopened)
            (root / name).write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(1024))
            self.assertEqual(matrix.restored_session_evidence(root, live, reopened), [name])

    def test_relaunch_cannot_replace_layout_generation_session_or_visible_capture(self):
        cases = [{"restoredTerminalViewsVisible": False}, {"replayed": False}, {"restoredSplitLayout": {"kind": "split", "axis": "vertical", "sessions": ["first", "second"]}}, {"sessions": []},
                 {"sessions": [{"id": "first", "generation": "generation-one"}, {"id": "second", "generation": "new-generation"}]},
                 {"sessions": [{"id": "first", "generation": "generation-one"}] * 2},
                 {"sessions": [{"id": "first", "generation": 1}, {"id": "second", "generation": "generation-two"}]},
                 {"captures": []}, {"captures": ["old.png"]}]
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            for changes in cases:
                live, reopened = self.reopened_reports()
                reopened.update(changes)
                with self.subTest(changes=changes), self.assertRaises(AssertionError):
                    matrix.restored_session_evidence(root, live, reopened)

    def project_report(self):
        proof = {key: True for key in ["passed", "actualMenuActions", "stalePinRejected", "staleMoveRejected", "peerSettingRetained", "terminalGenerationsAndViewsRetained", "splitLayoutRetainedInReopenedSnapshot", "movedAndReturned"]}
        proof.update(sourceHeadSHA="head", testedMergeSHA="merge", platform="macOS", architecture="arm64", system="fixture", groupMenuExecuted=True, physicalDragExecuted=False, screenshot="native-project-workspace-move.png")
        proof["dragSimulation"] = {key: True for key in ["passed", "actualNSTableViewCallbacks", "ownedPasteboard", "foreignSourceRejected", "forgedPayloadRejected", "cancelledDragRejected", "staleRevisionRejected", "freshDropAndReverseVerified"]}
        return {"sourceHeadSHA": "head", "testedMergeSHA": "merge", "sourceTreeDirty": False, "productionDataAccess": False, "passed": True, "platform": "macOS", "architecture": "arm64", "system": "fixture", "nativeProjectMenuRevisionAndWorkspaceMove": proof}

    def test_native_project_layout_requires_menu_identity_and_labelled_callback_proof(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            name = "native-project-workspace-move.png"
            (root / name).write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(1024))
            report = self.project_report()
            self.assertEqual(matrix.project_layout_evidence(root, report, "head", "merge"), [name])
            report["nativeProjectMenuRevisionAndWorkspaceMove"]["groupMenuExecuted"] = False
            self.assertEqual(matrix.project_layout_evidence(root, report, "head", "merge"), [name])

    def test_project_layout_rejects_old_or_cross_platform_nested_proofs(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            for changes in [{"sourceHeadSHA": "old"}, {"testedMergeSHA": "old"}, {"platform": "win32"}, {"architecture": "x86_64"}, {"system": "other"}]:
                report = self.project_report()
                report["nativeProjectMenuRevisionAndWorkspaceMove"].update(changes)
                with self.subTest(changes=changes), self.assertRaises(AssertionError):
                    matrix.project_layout_evidence(root, report, "head", "merge")

    def test_missing_failed_or_non_boolean_project_and_drag_checks_stay_unaccepted(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            baseline = self.project_report()
            proof = baseline["nativeProjectMenuRevisionAndWorkspaceMove"]
            groups = [(None, [key for key, value in proof.items() if value is True and key != "groupMenuExecuted"]), ("dragSimulation", list(proof["dragSimulation"]))]
            for group, keys in groups:
                for key in keys:
                    for value in [None, False, 1]:
                        report = copy.deepcopy(baseline)
                        target = report["nativeProjectMenuRevisionAndWorkspaceMove"]
                        if group:
                            target = target[group]
                        if value is None:
                            del target[key]
                        else:
                            target[key] = value
                        with self.subTest(group=group, key=key, value=value), self.assertRaises(AssertionError):
                            matrix.project_layout_evidence(root, report, "head", "merge")

    def test_project_layout_cannot_promote_simulation_to_physical_dragging(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            for changes in [{"physicalDragExecuted": True}, {"physicalDragExecuted": 0}, {"groupMenuExecuted": "true"}]:
                report = self.project_report()
                report["nativeProjectMenuRevisionAndWorkspaceMove"].update(changes)
                with self.subTest(changes=changes), self.assertRaises(AssertionError):
                    matrix.project_layout_evidence(root, report, "head", "merge")

    def test_project_layout_requires_its_original_scene_not_another_capture(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            report = self.project_report()
            with self.assertRaises(FileNotFoundError):
                matrix.project_layout_evidence(root, report, "head", "merge")
            (root / "other.png").write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(1024))
            report["nativeProjectMenuRevisionAndWorkspaceMove"]["screenshot"] = "other.png"
            with self.assertRaises(AssertionError):
                matrix.project_layout_evidence(root, report, "head", "merge")
            report["nativeProjectMenuRevisionAndWorkspaceMove"]["screenshot"] = "../other.png"
            with self.assertRaises(AssertionError):
                matrix.project_layout_evidence(root, report, "head", "merge")

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
