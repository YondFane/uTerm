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
from database_qa_service import DatabaseService

with tempfile.TemporaryDirectory(prefix="uterm-ssh-tauri-qa-") as directory:
    service = SSHService(directory, Path("ci-evidence/tauri-ssh-service"))
    redis = RedisService(directory, Path("ci-evidence/tauri-redis-service"))
    database = DatabaseService(directory, Path("ci-evidence/tauri-database-service"))
    try:
        database.start()
        redis.start()
        environment = service.environment()
        environment["UTERM_QA_SSH_FIXTURE"] = str(service.context)
        environment["UTERM_QA_REDIS_FIXTURE"] = str(redis.context)
        environment["UTERM_QA_DATABASE_FIXTURE"] = str(database.context)
        subprocess.run(["node", "scripts/tauri-state-qa.mjs"], env=environment, check=True)
        redis.verify_after_app_exit()
        database.verify_after_app_exit()
    finally:
        try:
            database.stop()
        finally:
            try:
                service.close()
            finally:
                try:
                    redis.close()
                finally:
                    database.close()
