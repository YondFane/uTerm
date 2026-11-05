"""Isolated real OpenSSH fixture; private keys and credentials never enter artifacts.
隔离的真实 OpenSSH 夹具；私钥和凭据不进入产物。
"""

import getpass
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
import secrets
import uuid


class SSHService:
    def __init__(self, directory, evidence):
        self.directory = Path(directory).resolve()
        self.evidence = Path(evidence).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.process = None
        self.stopped = threading.Event()
        self.sockets = []
        self.lock = threading.Lock()
        self.workers = []
        self.listener = None
        self.proxy = None
        self.client_backup = None
        self.mac_user = None
        self.mac_ssh_group = False
        self.password = secrets.token_hex(24) + "aA1!"
        try:
            for name in ["host", "client"]:
                subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(self.directory / name)], check=True)
            self.remote = self.directory / "remote 中文"
            self.remote.mkdir()
            self.local = self.directory / "local 中文.txt"
            self.local.write_bytes("SSH file 中文 e\u0301\r\n".encode())
            (self.remote / "original 中文.txt").write_bytes(self.local.read_bytes())
            (self.directory / "authorized_keys").write_bytes((self.directory / "client.pub").read_bytes())
            self.user = getpass.getuser()
            with socket.socket() as reserved:
                reserved.bind(("127.0.0.1", 0))
                self.server_port = reserved.getsockname()[1]
            config = self.directory / "sshd_config"
            if sys.platform == "win32":
                self._windows("Start", {"port": self.server_port, "runner": self.user, "remote": str(self.remote), "log": str(self.evidence / "ssh-server.log")})
                owned = json.loads((self.directory / "owned-service.json").read_text(encoding="utf-8-sig"))
                self.password_user = owned["user"]
            else:
                if sys.platform == "darwin" and os.environ.get("GITHUB_ACTIONS") == "true":
                    self._mac_account()
                config.write_text(
                f"ListenAddress 127.0.0.1\nPort {self.server_port}\nHostKey {self.directory}/host\n"
                f"PidFile {self.directory}/server.pid\nAuthorizedKeysFile {self.directory}/authorized_keys\n"
                f"StrictModes no\nPasswordAuthentication {'yes' if self.mac_user else 'no'}\nKbdInteractiveAuthentication no\nUsePAM {'yes' if self.mac_user else 'no'}\n"
                f"AllowUsers {self.user} {self.mac_user or ''}\nLogLevel VERBOSE\nSubsystem sftp internal-sftp\n"
                )
                command = (["sudo", "-n"] if sys.platform == "darwin" else []) + ["/usr/sbin/sshd", "-D", "-e", "-f", str(config)]
                self.log = (self.evidence / "ssh-server.log").open("w")
                self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
            deadline = time.monotonic() + (30 if sys.platform == "win32" else 8)
            while True:
                if self.process and self.process.poll() is not None:
                    raise RuntimeError("Isolated sshd stopped during startup; see ssh-server.log")
                try:
                    with socket.create_connection(("127.0.0.1", self.server_port), timeout=0.1):
                        break
                except OSError:
                    if time.monotonic() >= deadline:
                        if sys.platform == "win32":
                            (self.evidence / "ssh-task-status.json").write_text(self._windows("Status"))
                        raise RuntimeError("Isolated sshd startup timeout")
                    time.sleep(0.05)
            self.listener = socket.socket()
            self.listener.bind(("127.0.0.1", 0))
            self.port = self.listener.getsockname()[1]
            self.listener.listen()
            self.listener.settimeout(0.1)
            self.proxy = threading.Thread(target=self._accept, daemon=True)
            self.proxy.start()
            known = self.directory / "known_hosts"
            known.write_text("qa-native-host " + (self.directory / "host.pub").read_text())
            token = uuid.uuid4().hex
            self.alias = "qa-service-" + token
            self.unknown_alias = "qa-unknown-" + token
            self.password_alias = "qa-password-" + token
            self.client_config = self.directory / "ssh_config"
            key_path = (self.directory / "client").as_posix()
            known_path = known.as_posix()
            self.client_config.write_text(
                f"Host {self.alias} {self.unknown_alias} {self.password_alias}\n HostName 127.0.0.1\n Port {self.port}\n"
                f" IdentityFile \"{key_path}\"\n IdentitiesOnly yes\n"
                f" UserKnownHostsFile \"{known_path}\"\n GlobalKnownHostsFile {'NUL' if sys.platform == 'win32' else '/dev/null'}\n"
                f"Host {self.alias} {self.unknown_alias}\n User {self.user}\n"
                f"Host {self.alias} {self.password_alias}\n HostKeyAlias qa-native-host\n"
                f"Host {self.unknown_alias}\n HostKeyAlias qa-untrusted-host\n"
                f"Host {self.password_alias}\n User {getattr(self, 'password_user', self.user)}\n"
            )
            self.bin = self.directory / "bin"
            self.bin.mkdir()
            ssh = shutil.which("ssh")
            if not ssh:
                raise RuntimeError("System OpenSSH client missing")
            if sys.platform == "win32":
                # The production Windows client selects System32 OpenSSH, so only disposable CI gets temporary aliases. 正式 Windows 客户端选择 System32 OpenSSH，因此只在一次性 CI 添加临时别名。
                self.user_config = Path.home() / ".ssh" / "config"
                self.user_config.parent.mkdir(exist_ok=True)
                self.client_backup = self.user_config.read_bytes() if self.user_config.exists() else b""
                self.client_config_existed = self.user_config.exists()
                self.user_config.write_bytes(self.client_config.read_bytes() + b"\nHost *\n" + self.client_backup)
            else:
                wrapper = self.bin / "ssh"
                wrapper.write_text("#!/bin/sh\nexec " + shlex.quote(ssh) + " -F " + shlex.quote(str(self.client_config)) + ' "$@"\n')
                wrapper.chmod(0o700)
            self.context = self.directory / "fixture.json"
            self.context.write_text(json.dumps({"alias":self.alias, "unknownAlias":self.unknown_alias, "passwordAlias":self.password_alias, "identity":str(self.directory / "client"), "remote":str(self.remote), "passwordRemote":str(getattr(self, 'mac_home', self.remote)), "source":str(self.local), "directory":str(self.directory), "port":str(self.server_port), "passwordServiceLogin":bool(getattr(self, 'password_user', None)), "password":self.password}))
        except BaseException:
            self.close()
            raise

    def _windows(self, action, settings=None):
        if os.environ.get("GITHUB_ACTIONS") != "true":
            raise RuntimeError("Windows SSH fixtures require a disposable GitHub runner")
        if settings:
            (self.directory / "server-settings.json").write_text(json.dumps(settings))
        environment = os.environ.copy()
        environment["UTERM_QA_PASSWORD"] = self.password
        return subprocess.check_output(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(Path(__file__).with_name("windows-ssh-service.ps1")), "-Action", action, "-Root", str(self.directory)], env=environment, text=True)

    def _mac_account(self):
        self.mac_user = "utssh" + uuid.uuid4().hex[:12]
        self.password_user = self.mac_user
        occupied = {int(line.split()[-1]) for line in subprocess.check_output(["dscl", ".", "-list", "/Users", "UniqueID"], text=True).splitlines()}
        identifier = next(value for value in range(1000, 5000) if value not in occupied)
        self.mac_home = Path("/private/tmp") / ("uterm-ssh-home-" + uuid.uuid4().hex)
        subprocess.run(["sudo", "-n", "mkdir", str(self.mac_home)], check=True)
        record = "/Users/" + self.mac_user
        for key, value in [("UniqueID", str(identifier)), ("GeneratedUID", str(uuid.uuid4()).upper()), ("PrimaryGroupID", "20"), ("NFSHomeDirectory", str(self.mac_home)), ("UserShell", "/bin/bash")]:
            subprocess.run(["sudo", "-n", "dscl", ".", "-create", record, key, value], check=True)
        subprocess.run(["sudo", "-n", "dscl", ".", "-passwd", record, self.password], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["sudo", "-n", "chown", self.mac_user + ":staff", str(self.mac_home)], check=True)
        if subprocess.run(["dscl", ".", "-read", "/Groups/com.apple.access_ssh"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            subprocess.run(["sudo", "-n", "dseditgroup", "-o", "edit", "-a", self.mac_user, "-t", "user", "com.apple.access_ssh"], check=True)
            self.mac_ssh_group = True
        # Password checks do not read the caller's private fixture; use the account's own isolated home. 密码检查不读取调用者的私有夹具，使用该账户独立的临时主目录。
        (self.directory / "password-remote.txt").write_text(str(self.mac_home))

    def _copy(self, source, destination):
        try:
            while not self.stopped.is_set():
                data = source.recv(32768)
                if not data:
                    break
                destination.sendall(data)
                time.sleep(0.001)
        except OSError:
            pass
        finally:
            for stream in [source, destination]:
                try:
                    stream.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def _accept(self):
        while not self.stopped.is_set():
            try:
                incoming, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            outgoing = socket.create_connection(("127.0.0.1", self.server_port), timeout=5)
            incoming.settimeout(None)
            outgoing.settimeout(None)
            with self.lock:
                self.sockets.extend([incoming, outgoing])
            for source, destination in [(incoming, outgoing), (outgoing, incoming)]:
                worker = threading.Thread(target=self._copy, args=(source, destination), daemon=True)
                self.workers.append(worker)
                worker.start()

    def close(self):
        self.stopped.set()
        if self.listener:
            self.listener.close()
        if self.proxy:
            self.proxy.join(timeout=6)
        with self.lock:
            for stream in self.sockets:
                try:
                    stream.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                stream.close()
            self.sockets.clear()
        for worker in self.workers:
            worker.join(timeout=3)
        if self.process and self.process.poll() is None:
            if sys.platform == "darwin":
                pidfile = self.directory / "server.pid"
                if pidfile.is_file():
                    pid = int(pidfile.read_text().strip())
                    subprocess.run(["sudo", "-n", "/bin/kill", "-TERM", str(pid)], check=True)
            else:
                self.process.terminate()
            self.process.wait(timeout=10)
        if hasattr(self, "log"):
            self.log.close()
        if self.client_backup is not None:
            if self.client_config_existed:
                self.user_config.write_bytes(self.client_backup)
            else:
                self.user_config.unlink(missing_ok=True)
            self.client_backup = None
        if sys.platform == "win32":
            self._windows("Stop")
        if self.mac_user:
            if self.mac_ssh_group:
                subprocess.run(["sudo", "-n", "dseditgroup", "-o", "edit", "-d", self.mac_user, "-t", "user", "com.apple.access_ssh"], check=True)
            subprocess.run(["sudo", "-n", "dscl", ".", "-delete", "/Users/" + self.mac_user], check=True)
            self.mac_user = None
            subprocess.run(["sudo", "-n", "rm", "-rf", str(self.mac_home)], check=True)

    def cut_connections(self):
        with self.lock:
            for stream in self.sockets:
                try:
                    stream.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def environment(self):
        environment = os.environ.copy()
        environment["PATH"] = str(self.bin) + os.pathsep + environment["PATH"]
        return environment
