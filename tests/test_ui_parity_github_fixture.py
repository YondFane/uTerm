import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("github_fixture", Path(__file__).parents[1] / "scripts/ui-parity-github-fixture.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GitHubFixtureTests(unittest.TestCase):
    def test_new_private_repository_and_cli_read_without_an_account(self):
        with tempfile.TemporaryDirectory(prefix="uterm-parity-中文-") as directory:
            parent = Path(directory)
            project, root = parent / "project", parent / "uterm-native-qa-github-parity"
            environment = dict(os.environ, **module.prepare(root, project), GH_HOST="github.com", GH_PROMPT_DISABLED="1", GH_PAGER="cat")
            environment.pop("GH_REPO", None)
            self.assertEqual(subprocess.check_output(["git", "-C", str(project), "branch", "--show-current"], text=True).strip(), "qa-feature")
            self.assertEqual(subprocess.check_output(["git", "-C", str(project), "remote", "get-url", "origin"], text=True).strip(), "https://github.com/fixture-owner/fixture-repo.git")
            reply = json.loads(subprocess.check_output([str(root / "tools/gh"), "pr", "list"], env=environment, text=True))
            self.assertEqual(reply[0]["number"], 8)
            self.assertTrue((root / "github-cli.jsonl").exists())
            with self.assertRaises(AssertionError): module.prepare(root, project)

    def test_existing_repository_and_external_project_are_never_modified(self):
        with tempfile.TemporaryDirectory(prefix="uterm-parity-guard-") as directory:
            parent = Path(directory)
            project, root = parent / "project", parent / "uterm-native-qa-github-parity"
            project.mkdir(); (project / ".git").write_text("gitdir: /outside/repository")
            with self.assertRaises(AssertionError): module.prepare(root, project)
            self.assertFalse(root.exists())
            self.assertEqual((project / ".git").read_text(), "gitdir: /outside/repository")
            with self.assertRaises(AssertionError): module.prepare(root, parent.parent / "project")

    def test_project_symlinks_and_reused_fixture_roots_are_refused(self):
        with tempfile.TemporaryDirectory(prefix="uterm-parity-link-") as directory:
            parent = Path(directory); outside = parent / "outside"; outside.mkdir()
            project, root = parent / "project", parent / "uterm-native-qa-github-parity"
            project.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(AssertionError): module.prepare(root, project)
            self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
