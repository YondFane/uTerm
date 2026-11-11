"""Prepare an isolated CLI/repository for real-window comparison. 为真实窗口对照准备隔离 CLI／仓库。"""

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path


def prepare(root, project):
    root, project = Path(root).absolute(), Path(project).absolute()
    assert root.parent == project.parent and root.name.startswith("uterm-native-qa-")
    sandbox = root.parent.parent if root.parent.name == "parity" else root.parent
    assert project.name == "project" and sandbox.name.startswith("uterm-")
    assert root.parent.is_dir() and not root.parent.is_symlink()
    assert not root.exists() and not root.is_symlink() and not project.is_symlink()
    assert not (project / ".git").exists() and not (project / ".git").is_symlink()
    fixture = json.loads((Path(__file__).resolve().parents[1] / "shared/fixtures/client-ui-parity.json").read_text())
    repository = fixture["github"]["repository"]
    root.mkdir(mode=0o700); tools = root / "tools"; tools.mkdir(mode=0o700)
    program = tools / "gh"
    shutil.copyfile(Path(__file__).resolve().parents[1] / "tests/fixtures/github-cli.py", program)
    program.chmod(0o700)
    project.mkdir(exist_ok=True)
    def git(*arguments):
        return subprocess.check_output(["git", "-c", "core.hooksPath=" + str(root / "no-hooks"), "-C", str(project), *arguments], stderr=subprocess.PIPE, text=True).strip()
    git("init", "--initial-branch=qa-feature")
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--no-gpg-sign", "-m", "UI parity pull request")
    assert "origin" not in git("remote").splitlines()
    git("remote", "add", "origin", "https://github.com/" + repository + ".git")
    return {"PATH": str(tools) + os.pathsep + os.environ["PATH"], "UTERM_GITHUB_FIXTURE_ROOT": str(root)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--project", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.root, args.project)))
