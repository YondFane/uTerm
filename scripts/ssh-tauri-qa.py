"""Provide a real SSH service to the isolated Tauri window harness.
为隔离 Tauri 窗口验证提供真实 SSH 服务。
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from ssh_qa_service import SSHService

with tempfile.TemporaryDirectory(prefix="uterm-ssh-tauri-qa-") as directory:
    service = SSHService(directory, Path("ci-evidence/tauri-ssh-service"))
    try:
        environment = service.environment()
        environment["UTERM_QA_SSH_FIXTURE"] = str(service.context)
        subprocess.run(["node", "scripts/tauri-state-qa.mjs"], env=environment, check=True)
    finally:
        service.close()
