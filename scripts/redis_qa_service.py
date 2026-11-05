"""Own a real, temporary Redis service for native Tauri QA.
为原生 Tauri 验证管理真实临时 Redis 服务。
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
import time
import urllib.request
import zipfile


WINDOWS_VERSION = "8.10.3"
WINDOWS_URL = (
    "https://github.com/redis-windows/redis-windows/releases/download/8.10.3/"
    "Redis-8.10.3-Windows-x64-cygwin.zip"
)
WINDOWS_SHA256 = "8000848c48668c8cd32f21386ce951d0e02c1aefae39443ab9d3de11ff8ebf9e"
TEXT_KEY = "tauri:中文"
ORIGINAL_TEXT = "9223372036854775807 中文🚀"
SAVED_TEXT = "TAURI_REDIS_SAVED_9223372036854775807 中文🚀"
BINARY_KEY = b"\x00\xffkey"
BINARY_VALUE = b"\xff\x00\x7f"


def extract_verified_windows_archive(archive, destination):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != WINDOWS_SHA256:
        raise AssertionError("Windows Redis archive SHA256 mismatch")
    destination.mkdir()
    with zipfile.ZipFile(archive) as bundle:
        for item in bundle.infolist():
            target = (destination / item.filename).resolve()
            if not target.is_relative_to(destination.resolve()):
                raise AssertionError("Windows Redis archive path escapes its private directory")
            if (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise AssertionError("Windows Redis archive contains a symbolic link")
        bundle.extractall(destination)
    binaries = list(destination.rglob("redis-server.exe"))
    if len(binaries) != 1:
        raise AssertionError("Windows Redis archive must contain one redis-server.exe")
    return binaries[0]


class RedisService:
    def __init__(self, directory, evidence):
        self.root = Path(directory) / "redis"
        self.root.mkdir()
        self.evidence = Path(evidence)
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.context = self.root / "private-fixture.json"
        self.password = secrets.token_hex(24)
        self.process = None
        self.verified = False
        self.report = {
            "sourceHeadSHA": os.environ.get("PR_HEAD_SHA") or self.git("rev-parse", "HEAD"),
            "testedMergeSHA": self.git("rev-parse", "HEAD"),
            "sourceTreeDirty": bool(self.git("status", "--porcelain")),
            "platform": platform.system(),
            "architecture": platform.machine(),
            "system": platform.platform(),
            "productionDataAccess": False,
            "realRedisDataVerifiedAfterAppExit": False,
            "passed": False,
        }

    @staticmethod
    def git(*args):
        return subprocess.check_output(["git", *args], text=True).strip()

    def start(self):
        if os.name == "nt":
            archive = self.root / "redis.zip"
            with urllib.request.urlopen(WINDOWS_URL, timeout=120) as response:
                with archive.open("wb") as output:
                    total = 0
                    while data := response.read(1024 * 1024):
                        total += len(data)
                        if total > 64 * 1024 * 1024:
                            raise AssertionError("Windows Redis archive exceeds the download limit")
                        output.write(data)
            binary = extract_verified_windows_archive(archive, self.root / "server")
            self.report.update(redisDistribution="redis-windows portable Cygwin build",
                               redisArchiveURL=WINDOWS_URL, redisArchiveSHA256=WINDOWS_SHA256)
        else:
            binary = shutil.which("redis-server")
            if not binary and platform.system() == "Darwin":
                subprocess.run(["brew", "install", "redis"], check=True,
                               env=dict(os.environ, HOMEBREW_NO_AUTO_UPDATE="1"))
                binary = shutil.which("redis-server")
            if not binary:
                raise AssertionError("A real redis-server is required; mocks are not accepted")
            binary = Path(binary).resolve()
            self.report["redisDistribution"] = "Homebrew" if platform.system() == "Darwin" else "local"
        self.report.update(
            redisVersion=subprocess.check_output([str(binary), "--version"], text=True).strip(),
            redisBinarySHA256=hashlib.sha256(binary.read_bytes()).hexdigest(),
        )
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        config = self.root / "redis.conf"
        config.write_text(f'bind 127.0.0.1\nport {self.port}\nsave ""\nappendonly no\n'
                          f'requirepass {self.password}\ndir "."\n', encoding="utf-8")
        config.chmod(0o600)
        with (self.evidence / "redis-server.log").open("w", encoding="utf-8") as log:
            self.process = subprocess.Popen([str(binary), config.name], cwd=self.root,
                                            stdout=log, stderr=subprocess.STDOUT)
        for _ in range(200):
            if self.process.poll() is not None:
                raise AssertionError("Private Redis exited during startup")
            try:
                if self.command("PING") == b"PONG":
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise AssertionError("Private Redis startup timed out")
        assert self.command("SET", TEXT_KEY, ORIGINAL_TEXT, "EX", "3600") == b"OK"
        assert self.command("SET", BINARY_KEY, BINARY_VALUE) == b"OK"
        self.context.write_text(json.dumps({"port": self.port, "password": self.password,
                                           "textKey": TEXT_KEY, "originalText": ORIGINAL_TEXT,
                                           "savedText": SAVED_TEXT}), encoding="utf-8")
        self.context.chmod(0o600)
        self.report["ownedServerPID"] = self.process.pid
        return self

    def command(self, *values):
        def send(connection, args):
            args = [value if isinstance(value, bytes) else str(value).encode() for value in args]
            connection.sendall(b"*" + str(len(args)).encode() + b"\r\n" + b"".join(
                b"$" + str(len(value)).encode() + b"\r\n" + value + b"\r\n" for value in args))

        def read(stream):
            line = stream.readline(4096)
            if not line.endswith(b"\r\n") or line.startswith(b"-"):
                raise AssertionError("Private Redis rejected a command or returned an incomplete reply")
            if line.startswith(b"$"):
                size = int(line[1:-2])
                if size == -1:
                    return None
                assert 0 <= size <= 1024 * 1024
                data = stream.read(size + 2)
                assert len(data) == size + 2 and data.endswith(b"\r\n")
                return data[:-2]
            assert line[:1] in (b"+", b":")
            return line[1:-2]

        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as connection:
            with connection.makefile("rb") as stream:
                send(connection, ["AUTH", self.password])
                assert read(stream) == b"OK"
                send(connection, values)
                return read(stream)

    def verify_after_app_exit(self):
        assert self.command("GET", TEXT_KEY) == SAVED_TEXT.encode()
        assert int(self.command("PTTL", TEXT_KEY)) > 0
        assert self.command("GET", BINARY_KEY) == BINARY_VALUE
        self.verified = True
        self.report["realRedisDataVerifiedAfterAppExit"] = True

    def close(self):
        try:
            if self.process is not None and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=10)
            stopped = self.process is not None and self.process.poll() is not None
            self.report.update(ownedServerStopped=stopped, passed=self.verified and stopped)
        finally:
            leaked = []
            unreadable = []
            # Credentials stay in the private fixture, never in uploaded evidence.
            # 凭据仅存于私有测试数据，不能进入上传证据。
            for file in Path("ci-evidence").rglob("*"):
                if file.is_file() and file.suffix in (".log", ".json", ".txt"):
                    content = None
                    for attempt in range(20):
                        try:
                            content = file.read_bytes()
                            break
                        except PermissionError:
                            if attempt < 19:
                                time.sleep(0.05)
                        except OSError:
                            break
                    if content is None:
                        unreadable.append(str(file))
                        continue
                    if self.password.encode() in content:
                        leaked.append(file.name)
                        file.write_bytes(content.replace(self.password.encode(), b"<REDACTED_QA_SECRET>"))
            self.report["credentialLeakDetected"] = bool(leaked)
            self.report["evidenceInspectionErrors"] = unreadable
            self.report["passed"] = bool(self.report["passed"] and not leaked and not unreadable)
            (self.evidence / "redis-live.json").write_text(
                json.dumps(self.report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            if leaked:
                raise AssertionError("Temporary Redis credential appeared in evidence: " + ", ".join(leaked))
            if unreadable:
                raise AssertionError("QA evidence could not be inspected: " + ", ".join(unreadable))
