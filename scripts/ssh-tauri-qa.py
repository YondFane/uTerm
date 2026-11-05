"""Provide a real SSH service to the isolated Tauri window harness.
为隔离 Tauri 窗口验证提供真实 SSH 服务。
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from ssh_qa_service import SSHService
from redis_qa_service import RedisService

with tempfile.TemporaryDirectory(prefix="uterm-ssh-tauri-qa-") as directory:
    service = SSHService(directory, Path("ci-evidence/tauri-ssh-service"))
    redis = RedisService(directory, Path("ci-evidence/tauri-redis-service"))
    try:
        redis.start()
        environment = service.environment()
        environment["UTERM_QA_SSH_FIXTURE"] = str(service.context)
        environment["UTERM_QA_REDIS_FIXTURE"] = str(redis.context)
        subprocess.run(["node", "scripts/tauri-state-qa.mjs"], env=environment, check=True)
        redis.verify_after_app_exit()
    finally:
        try:
            redis.close()
        finally:
            service.close()
