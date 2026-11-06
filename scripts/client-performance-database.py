"""Keep the same owned PostgreSQL cluster across sequential client measurements.
在顺序客户端测量期间保持同一个自有 PostgreSQL 集群。
"""
import os
from pathlib import Path
import subprocess
import tempfile
import json
import shutil
from database_qa_service import DatabaseService


with tempfile.TemporaryDirectory(prefix="uterm-performance-service-") as directory:
    service = DatabaseService(directory, Path("ci-evidence/performance/database-service"))
    try:
        service.start()
        bash = "/bin/bash"
        if os.name == "nt":
            git = shutil.which("git")
            assert git, "Git for Windows is required"
            bash = str(Path(git).parent.parent / "bin/bash.exe")
            assert Path(bash).is_file(), "Git Bash is unavailable; do not use the WSL launcher"
        subprocess.run([bash, "scripts/run-client-performance.sh"], check=True,
                       env=dict(os.environ, UTERM_QA_DATABASE_FIXTURE=str(service.context)))
        assert service.sql("SELECT note FROM qa_exact WHERE id=1") == "ORIGINAL_DATABASE_TEXT"
        assert service.sql("SELECT count(*) FROM pg_stat_activity WHERE usename='uterm_qa' "
                           "AND pid<>pg_backend_pid() AND backend_type='client backend'") == "0"
        service.verified = True
        service.report.update(readonlyFixtureUnchanged=True, noRemainingClientConnections=True)
    finally:
        try:
            service.close()
        finally:
            leaked = []
            for path in Path("ci-evidence").rglob("*"):
                if path.is_file() and path.suffix in [".json", ".log", ".txt"]:
                    content = path.read_bytes()
                    if service.password.encode() in content:
                        leaked.append(path.name)
                        path.write_bytes(content.replace(service.password.encode(), b"<REDACTED_QA_SECRET>"))
            if leaked:
                service.report.update(passed=False, credentialExcludedFromEvidence=False, redactedFiles=leaked)
                (service.evidence / "database-live.json").write_text(json.dumps(service.report, indent=2)+"\n", encoding="utf-8")
                raise AssertionError("Temporary database credential appeared in evidence: " + ", ".join(leaked))
