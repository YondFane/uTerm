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


class SSHService:
    def __init__(self, directory, evidence):
        self.directory = Path(directory)
        self.evidence = Path(evidence)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.process = None
        self.stopped = threading.Event()
        self.sockets = []
        self.lock = threading.Lock()
        self.workers = []
        self.listener = None
        self.proxy = None
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
            config.write_text(
                f"ListenAddress 127.0.0.1\nPort {self.server_port}\nHostKey {self.directory}/host\n"
                f"PidFile {self.directory}/server.pid\nAuthorizedKeysFile {self.directory}/authorized_keys\n"
                f"StrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\n"
                f"AllowUsers {self.user}\nLogLevel VERBOSE\nSubsystem sftp internal-sftp\n"
            )
            command = (["sudo", "-n"] if sys.platform == "darwin" else []) + ["/usr/sbin/sshd", "-D", "-e", "-f", str(config)]
            self.log = (self.evidence / "ssh-server.log").open("w")
            self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
            deadline = time.monotonic() + 8
            while True:
                if self.process.poll() is not None:
                    raise RuntimeError("Isolated sshd stopped during startup; see ssh-server.log")
                try:
                    with socket.create_connection(("127.0.0.1", self.server_port), timeout=0.1):
                        break
                except OSError:
                    if time.monotonic() >= deadline:
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
            self.client_config = self.directory / "ssh_config"
            self.client_config.write_text(
                f"Host qa-service qa-unknown\n HostName 127.0.0.1\n User {self.user}\n Port {self.port}\n"
                f" IdentityFile \"{self.directory}/client\"\n IdentitiesOnly yes\n"
                f" UserKnownHostsFile \"{known}\"\n GlobalKnownHostsFile /dev/null\n"
                "Host qa-service\n HostKeyAlias qa-native-host\n"
                "Host qa-unknown\n HostKeyAlias qa-untrusted-host\n"
            )
            self.bin = self.directory / "bin"
            self.bin.mkdir()
            ssh = shutil.which("ssh")
            if not ssh:
                raise RuntimeError("System OpenSSH client missing")
            wrapper = self.bin / "ssh"
            wrapper.write_text("#!/bin/sh\nexec " + shlex.quote(ssh) + " -F " + shlex.quote(str(self.client_config)) + ' "$@"\n')
            wrapper.chmod(0o700)
            self.context = self.directory / "fixture.json"
            self.context.write_text(json.dumps({"alias":"qa-service", "unknownAlias":"qa-unknown", "identity":str(self.directory / "client"), "remote":str(self.remote), "source":str(self.local), "directory":str(self.directory), "port":str(self.server_port), "passwordServiceLogin":False}))
        except BaseException:
            self.close()
            raise

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

    def environment(self):
        environment = os.environ.copy()
        environment["PATH"] = str(self.bin) + os.pathsep + environment["PATH"]
        return environment
