"""Exercise the public Core contract against isolated OpenSSH, without GUI substitutes.
通过公开 Core 契约验证隔离 OpenSSH，不代替图形界面验收。
"""
import json
import os
from pathlib import Path
import platform
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from ssh_qa_service import SSHService


class Client:
    def __init__(self, binary, root, environment, log):
        self.process = subprocess.Popen([str(binary), "--serve", str(root)], env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8")
        self.lines = queue.Queue()
        def read():
            for line in self.process.stdout:
                self.lines.put(line)
            self.lines.put(None)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()

    def response(self, method, params=None):
        self.process.stdin.write(json.dumps({"version": 1, "id": "ssh-real-service", "method": method, "params": params}, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        line = self.lines.get(timeout=40)
        assert line is not None, "Core fixture closed unexpectedly"
        return json.loads(line)

    def call(self, method, params=None):
        response = self.response(method, params)
        assert not response.get("error"), (method, response.get("error"))
        return response.get("result")

    def start(self, kind, **params):
        return self.call("ssh.operation.start", {"kind": kind, **params})

    def wait(self, job, success=True, progress=None, trust=None):
        deadline = time.monotonic() + 90
        while True:
            value = self.call("ssh.operation.read", {"id": job["id"], "generation": job["generation"], "consume": True})
            if value["state"] != "running":
                if success:
                    assert value["state"] == "completed", (value["kind"], value.get("error"))
                return value
            if progress and value.get("progress"):
                progress(value)
                progress = None
            if trust is not None:
                for prompt in self.call("ssh.trust.pending"):
                    self.call("ssh.trust.confirm", {"id": prompt["id"], "approve": trust})
                    stale = self.response("ssh.trust.confirm", {"id": prompt["id"], "approve": trust})
                    assert stale["error"]["code"] == "SSH_TRUST_EXPIRED"
            assert time.monotonic() < deadline, "SSH operation timeout"
            time.sleep(0.025)

    def operation(self, kind, **params):
        return self.wait(self.start(kind, **params))["result"]

    def close(self):
        self.process.stdin.close()
        try:
            assert self.process.wait(timeout=15) == 0
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
            raise


def free_port():
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        return reserved.getsockname()[1]


def main():
    binary, evidence = map(Path, sys.argv[1:3])
    evidence.mkdir(parents=True, exist_ok=True)
    report = {"sourceHeadSHA": os.environ.get("PR_HEAD_SHA"), "testedMergeSHA": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(), "sourceTreeDirty": bool(subprocess.check_output(["git", "status", "--porcelain"])), "platform": sys.platform, "architecture": platform.machine(), "system": platform.platform(), "service": "Isolated OpenSSH sshd/internal-sftp; actual TCP, no mocked transport", "guiAcceptance": False, "checks": {}}
    assert not report["sourceTreeDirty"] or ("--allow-dirty" in sys.argv and os.environ.get("GITHUB_ACTIONS") != "true"), "Commit the fixture before collecting acceptance evidence"
    checks = report["checks"]
    with tempfile.TemporaryDirectory(prefix="uterm-ssh-core-qa-") as directory:
        root = Path(directory)
        service = SSHService(root / "fixture", evidence)
        client = None
        remembered = None
        try:
            with (evidence / "ssh-core-client.log").open("w") as log:
                client = Client(binary, root / "shared-state-v1", service.environment(), log)
                defaults = client.call("state.defaults")
                client.call("migration.import", {"workspace": defaults["workspace"], "settings": defaults["settings"], "legacy": {}})
                client.call("ssh.configure", {"credentialService": "sh.uterm.qa.ssh." + uuid.uuid4().hex})
                connection = {"connection_id": str(uuid.uuid4()), "workspace_id": "local", "name": "Real SSH QA 中文", "host": service.alias, "mode": "alias", "authentication": "key", "identity_file": str(service.directory / "client"), "os": "windows" if sys.platform == "win32" else "posix", "root": service.remote.as_posix()}
                remote = client.operation("files.open", connection=connection)
                listed = client.operation("files.list", root=remote, path="", hidden=True)
                assert any(v["name"] == "original 中文.txt" for v in listed["entries"])
                original = client.operation("files.read", root=remote, path="original 中文.txt")
                conflict = client.wait(client.start("files.save", root=remote, path="original 中文.txt", text="discard", expected="stale", force=False), success=False)
                assert conflict["state"] == "failed" and "CONFLICT" in conflict["error"]
                assert (service.remote / "original 中文.txt").read_bytes() == service.local.read_bytes()
                checks["actualSFTPAndStaleSaveProtection"] = True
                client.operation("files.transfer", root=remote, path="", direction="upload", paths=[str(service.local)], overwrite=False)
                destination = root / service.local.name
                client.operation("files.transfer", root=remote, path=service.local.name, direction="download", paths=[str(destination)], overwrite=False)
                assert destination.read_bytes() == service.local.read_bytes()
                checks["unicodeBinaryUploadDownload"] = True
                known = service.directory / "known_hosts"
                trusted = known.read_bytes()
                known.write_text("qa-native-host " + (service.directory / "client.pub").read_text())
                try:
                    untrusted = client.wait(client.start("files.open", connection=connection), success=False)
                    assert untrusted["state"] == "failed"
                finally:
                    known.write_bytes(trusted)
                checks["changedHostKeyRefused"] = True
                service.local.write_bytes(b"replacement" * (4 * 1024 * 1024))
                def cancel(value):
                    assert isinstance(value["progress"]["completed"], str)
                    stale = client.response("ssh.operation.cancel", {"id": value["id"], "generation": str(uuid.uuid4())})
                    assert stale["error"]["code"] == "SSH_OPERATION_CHANGED"
                    client.call("ssh.operation.cancel", {"id": value["id"], "generation": value["generation"]})
                cancelled = client.wait(client.start("files.transfer", root=remote, path="", direction="upload", paths=[str(service.local)], overwrite=True), success=False, progress=cancel)
                assert cancelled["state"] == "cancelled"
                assert (service.remote / service.local.name).read_bytes() == destination.read_bytes()
                checks["generationCancellationPreservesOriginal"] = True
                interrupted = client.wait(client.start("files.transfer", root=remote, path="", direction="upload", paths=[str(service.local)], overwrite=True), success=False, progress=lambda _: service.cut_connections())
                assert interrupted["state"] == "failed"
                assert (service.remote / service.local.name).read_bytes() == destination.read_bytes()
                remote = client.operation("files.open", connection=connection, expected=remote)
                client.operation("files.transfer", root=remote, path="", direction="upload", paths=[str(service.local)], overwrite=True)
                assert (service.remote / service.local.name).read_bytes() == service.local.read_bytes()
                checks["disconnectPreservesOriginalAndExplicitReconnectRetries"] = True
                rules = [{"id": str(uuid.uuid4()), "local_port": free_port(), "remote_host": "127.0.0.1", "remote_port": service.server_port} for _ in range(2)]
                for rule in rules:
                    client.call("ssh.tunnel.start", {"connection": connection, "rule": rule})
                deadline = time.monotonic() + 20
                while True:
                    statuses = client.call("ssh.tunnel.list")
                    if len(statuses) == 2 and all(v["state"] == "running" for v in statuses):
                        break
                    assert time.monotonic() < deadline, statuses
                    time.sleep(0.05)
                def banner(rule):
                    with socket.create_connection(("127.0.0.1", rule["local_port"]), timeout=5) as probe:
                        assert probe.recv(256).startswith(b"SSH-")
                for rule in rules:
                    banner(rule)
                first = next(v for v in statuses if v["id"] == rules[0]["id"])
                stop = {key: first[key] for key in ["connection_id", "id", "generation"]}
                stale = client.response("ssh.tunnel.stop", {**stop, "generation": str(uuid.uuid4())})
                assert stale["error"]["code"] == "SSH_FORWARD_CHANGED"
                client.call("ssh.tunnel.stop", stop)
                banner(rules[1])
                checks["staleTunnelStopRejectedAndSiblingSurvives"] = True
                quitting = client.start("files.transfer", root=remote, path="", direction="upload", paths=[str(service.local)], overwrite=True)
                client.wait(quitting, success=False, progress=lambda _: client.wait(client.start("prepareQuit")))
                assert not client.call("ssh.tunnel.list")
                refused = client.response("ssh.operation.start", {"kind": "files.open", "connection": connection})
                assert refused["error"]["code"] == "SSH_QUITTING"
                client.call("ssh.resume")
                checks["quitCancelsTransfersAndOnlyOwnedTunnels"] = True
                if getattr(service, "password_user", None):
                    password_connection = {**connection, "connection_id": str(uuid.uuid4()), "host": service.password_alias, "authentication": "password", "identity_file": None, "root": str(getattr(service, "mac_home", service.remote)).replace("\\", "/")}
                    remembered = client.operation("auth.configure", connection=password_connection, password=service.password, remember=True)
                    password_connection.update(credential_id=remembered, remember_password=True)
                    password_root = client.operation("files.open", connection=password_connection)
                    client.operation("files.list", root=password_root, path="", hidden=True)
                    client.operation("files.disconnect", connection_id=password_connection["connection_id"])
                    checks["actualPasswordLoginViaAskpassAndOSCredentialStore"] = True
                    unknown = {**password_connection, "connection_id": str(uuid.uuid4()), "host": service.unknown_alias, "root": connection["root"]}
                    reference = client.operation("auth.configure", connection=unknown, password=service.password, remember=False)
                    unknown.update(credential_id=reference, remember_password=False)
                    declined = client.wait(client.start("files.open", connection=unknown), success=False, trust=False)
                    assert declined["state"] == "failed"
                    checks["actualAskpassTrustDeclinedAndSingleUse"] = True
                for method in ["snapshot.read", "ssh.operations", "ssh.trust.pending"]:
                    assert service.password not in json.dumps(client.call(method))
                assert service.password not in (evidence / "ssh-server.log").read_text(errors="replace")
                checks["secretExcludedFromStateStatusAndServerLog"] = True
                client.operation("prepareQuit")
                client.call("ssh.resume")
        finally:
            try:
                if client:
                    try:
                        if remembered:
                            client.call("ssh.resume")
                            client.operation("auth.forget", reference=remembered, remember=True)
                    finally:
                        client.close()
            finally:
                service.close()
    report.update(passed=True, cleanup=True)
    (evidence / "ssh-core-live.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
