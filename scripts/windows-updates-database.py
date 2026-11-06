"""Own the real database for signed Windows update guard checks.
为 Windows 签名更新保护检查管理真实数据库。
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from database_qa_service import DatabaseService


with tempfile.TemporaryDirectory(prefix="uterm-updater-database-") as directory:
    evidence = Path("ci-evidence/updates-windows")
    service = DatabaseService(directory, evidence / "database-service")
    try:
        service.start()
        subprocess.run(["node", "scripts/windows-updates-smoke.mjs"], check=True,
                       env=dict(os.environ, UTERM_QA_DATABASE_FIXTURE=str(service.context)))
        assert service.sql("SELECT note FROM qa_exact WHERE id=1") == "ORIGINAL_DATABASE_TEXT"
        assert service.sql("SELECT count(*) FROM pg_stat_activity WHERE usename='uterm_qa' "
                           "AND pid<>pg_backend_pid() AND backend_type='client backend'") == "0"
        service.verified = True
        service.report.update(rollbackRetainedOriginalData=True, noRemainingClientConnections=True)
    finally:
        try:
            service.close()
        finally:
            leaked = []
            for path in evidence.rglob("*"):
                if path.is_file() and path.suffix in [".json", ".log", ".txt"]:
                    content = path.read_bytes()
                    if service.password.encode() in content:
                        leaked.append(path.name)
                        path.write_bytes(content.replace(service.password.encode(), b"<REDACTED_QA_SECRET>"))
            if leaked:
                service.report.update(passed=False, credentialExcludedFromEvidence=False, redactedFiles=leaked)
                (service.evidence / "database-live.json").write_text(json.dumps(service.report, indent=2)+"\n", encoding="utf-8")
                raise AssertionError("Temporary database credential appeared in evidence: " + ", ".join(leaked))
