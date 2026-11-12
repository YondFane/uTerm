"""Own a real PostgreSQL cluster for isolated desktop QA.
为隔离桌面验证管理真实 PostgreSQL 集群。
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import socket
import subprocess
import tempfile


def fetch_postgres_driver(destination):
    """Fetch the pinned QA driver, with an independent Maven Central DNS fallback.
    下载固定版本的 QA 驱动，并提供独立域名的 Maven Central 备用地址。
    """
    destination = Path(destination)
    catalog = Path(__file__).resolve().parent.parent / "components/database/catalog.json"
    artifact = json.loads(catalog.read_text(encoding="utf-8"))["drivers"]["postgresql"]
    primary = artifact["url"]
    assert primary.startswith("https://repo.maven.apache.org/maven2/")
    urls = [primary, primary.replace("https://repo.maven.apache.org/maven2/",
                                     "https://repo1.maven.org/maven2/", 1)]
    attempted = []
    with tempfile.TemporaryDirectory(prefix="uterm-qa-jdbc-", dir=destination.parent) as directory:
        candidate = Path(directory) / "postgresql.jar"
        for url in urls:
            attempted.append(url)
            try:
                subprocess.run(["curl", "--fail", "--location", "--retry", "2",
                                "--connect-timeout", "10", "--max-time", "60", "--silent",
                                "--show-error", "--output", str(candidate), url],
                               check=True, timeout=210)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                if url == urls[-1]:
                    raise
                candidate.unlink(missing_ok=True)
                continue
            # An integrity failure must not be hidden by a second download.
            # 完整性校验失败不能用另一次下载掩盖。
            digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
            if candidate.stat().st_size != artifact["size"] or digest != artifact["sha256"]:
                raise ValueError("Pinned PostgreSQL QA driver integrity check failed")
            candidate.replace(destination)
            return {"version": artifact["version"], "sha256": digest,
                    "size": artifact["size"], "sourceURL": url, "attemptedURLs": attempted}


SAVED_TEXT = json.loads((Path(__file__).resolve().parent.parent / "shared/fixtures/database-qa.json")
                        .read_text(encoding="utf-8"))["savedText"]


class DatabaseService:
    def __init__(self, directory, evidence):
        self.root = Path(directory) / "database"
        self.root.mkdir()
        self.data = self.root / "cluster"
        self.evidence = Path(evidence)
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.context = self.root / "private-fixture.json"
        self.password = secrets.token_hex(24)
        self.started = False
        self.verified = False
        self.report = {
            "sourceHeadSHA": os.environ.get("PR_HEAD_SHA") or self.git("rev-parse", "HEAD"),
            "testedMergeSHA": self.git("rev-parse", "HEAD"),
            "sourceTreeDirty": bool(self.git("status", "--porcelain")),
            "platform": platform.system(), "architecture": platform.machine(),
            "system": platform.platform(), "service": "real isolated PostgreSQL",
            "productionDataAccess": False, "passed": False,
        }

    @staticmethod
    def git(*args):
        return subprocess.check_output(["git", *args], text=True).strip()

    def executable(self, name):
        return str(self.binary / (name + (".exe" if os.name == "nt" else "")))

    def locate(self):
        candidates = []
        for key in ["UTERM_QA_POSTGRES_BIN", "PGBIN"]:
            if os.environ.get(key):
                candidates.append(Path(os.environ[key]))
        installed = shutil.which("initdb")
        if installed:
            candidates.append(Path(installed).parent)
        if os.name == "nt":
            base = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "PostgreSQL"
            candidates.extend(sorted(base.glob("*/bin"), reverse=True))
        elif platform.system() == "Darwin":
            prefix = subprocess.check_output(["brew", "--prefix", "postgresql@16"], text=True).strip()
            if not (Path(prefix) / "bin/initdb").is_file():
                subprocess.run(["brew", "install", "postgresql@16"], check=True,
                               env=dict(os.environ, HOMEBREW_NO_AUTO_UPDATE="1"))
            candidates.append(Path(prefix) / "bin")
        else:
            candidates.extend(sorted(Path("/usr/lib/postgresql").glob("*/bin"), reverse=True))
        suffix = ".exe" if os.name == "nt" else ""
        for candidate in candidates:
            if all((candidate / (name + suffix)).is_file()
                   for name in ["initdb", "pg_ctl", "postgres", "createdb", "psql"]):
                return candidate.resolve()
        raise AssertionError("PostgreSQL binaries are unavailable; no system service was changed")

    def sql(self, text):
        return subprocess.check_output(
            [self.executable("psql"), "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
             "-h", "127.0.0.1", "-p", str(self.port), "-U", "uterm_qa", "-d", "uterm_qa",
             "-c", text],
            env=dict(os.environ, PGPASSWORD=self.password, PGCLIENTENCODING="UTF8"),
            text=True, encoding="utf-8", timeout=15,
        ).strip()

    def start(self):
        self.binary = self.locate()
        password_file = self.root / "password"
        password_file.write_text(self.password + "\n", encoding="utf-8")
        password_file.chmod(0o600)
        with (self.evidence / "postgres-init.log").open("w", encoding="utf-8") as log:
            subprocess.run([self.executable("initdb"), "-D", str(self.data),
                            "--username=uterm_qa", "--pwfile=" + str(password_file),
                            "--auth-local=trust", "--auth-host=scram-sha-256", "--encoding=UTF8",
                            "--no-locale"], check=True, stdout=log, stderr=subprocess.STDOUT,
                           timeout=60)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        with (self.data / "postgresql.conf").open("a", encoding="utf-8") as config:
            config.write("\nlisten_addresses='127.0.0.1'\nport=" + str(self.port)
                         + "\nunix_socket_directories=''\n")
        subprocess.run([self.executable("pg_ctl"), "-D", str(self.data), "-l",
                        str(self.evidence.resolve() / "postgres.log"), "-w", "-t", "30", "start"],
                       check=True, timeout=45)
        self.started = True
        subprocess.run([self.executable("createdb"), "-h", "127.0.0.1", "-p", str(self.port),
                        "-U", "uterm_qa", "uterm_qa"],
                       env=dict(os.environ, PGPASSWORD=self.password), check=True, timeout=15)
        self.sql("CREATE TABLE qa_exact (id integer PRIMARY KEY, note text NOT NULL); "
                 "INSERT INTO qa_exact VALUES (1, 'ORIGINAL_DATABASE_TEXT');")
        self.context.write_text(json.dumps({"port": self.port, "password": self.password,
                                            "savedText": SAVED_TEXT}), encoding="utf-8")
        self.context.chmod(0o600)
        self.report.update(
            postgresVersion=subprocess.check_output([self.executable("postgres"), "--version"],
                                                     text=True).strip(),
            postgresBinarySHA256=hashlib.sha256(Path(self.executable("postgres")).read_bytes()).hexdigest(),
        )

    def verify_after_app_exit(self):
        assert self.sql("SELECT note FROM qa_exact WHERE id=1") == SAVED_TEXT
        assert self.sql("SELECT count(*) FROM pg_stat_activity WHERE usename='uterm_qa' "
                        "AND pid<>pg_backend_pid() AND backend_type='client backend'") == "0"
        self.verified = True
        self.report.update(committedDataVerifiedAfterAppExit=True, noRemainingClientConnections=True)

    def stop(self):
        # Stop only the cluster created under this fixture, never an installed system service.
        # 仅停止此测试目录中的自有集群，不操作已安装的系统服务。
        if hasattr(self, "binary") and (self.data / "postmaster.pid").exists():
            subprocess.run([self.executable("pg_ctl"), "-D", str(self.data), "-w", "-t", "15",
                            "-m", "immediate", "stop"], check=True, timeout=25)
        self.report["ownedServerStopped"] = not (self.data / "postmaster.pid").exists()

    def close(self):
        try:
            self.stop()
            leaked = []
            for path in self.evidence.parent.rglob("*"):
                if path.is_file() and path.suffix in [".json", ".log", ".txt"]:
                    content = path.read_bytes()
                    if self.password.encode() in content:
                        leaked.append(path.name)
                        path.write_bytes(content.replace(self.password.encode(), b"<REDACTED_QA_SECRET>"))
            assert not leaked, "Temporary database credential appeared in evidence: " + ", ".join(leaked)
            self.report["credentialExcludedFromEvidence"] = True
            self.report["passed"] = self.verified and self.report["ownedServerStopped"]
        finally:
            (self.evidence / "database-live.json").write_text(
                json.dumps(self.report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
