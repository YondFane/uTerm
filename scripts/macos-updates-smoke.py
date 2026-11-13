"""Exercise the actual Sparkle SDK against private loopback feeds. 使用私有回环源执行真实 Sparkle SDK。"""

import argparse
import base64
import hashlib
import http.server
import json
import os
import platform
import plistlib
import shutil
import socket
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request
import uuid
from pathlib import Path

from macos_qa_http import LoopbackHTTPServer

TOOLKIT_URL = "https://github.com/sparkle-project/Sparkle/releases/download/2.10.1/Sparkle-2.10.1.tar.xz"
TOOLKIT_SHA256 = "1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27"


def run(*arguments, timeout=120):
    result = subprocess.run([str(v) for v in arguments], capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{arguments[0]} exited {result.returncode}: " + result.stderr.decode(errors="replace")[:1500])
    return result.stdout


def configure_app(source, destination, info):
    run("ditto", source, destination)
    (destination / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
    run("codesign", "--force", "--sign", "-", destination)
    run("codesign", "--verify", "--deep", "--strict", destination)


def validate_capture_request(request, head, tested, identity, original_pid):
    assert request["sourceHeadSHA"] == head and request["testedMergeSHA"] == tested
    assert request["bundleIdentifier"] == identity and request["pid"] != original_pid
    assert type(request["pid"]) is int and request["pid"] > 0
    assert type(request["windowNumber"]) is int and request["windowNumber"] > 0
    assert request["screenshot"] == "native-update-install-relaunched.png"


def exercise(source, folder, evidence, signer, mode, head, tested, capture_tool, database_fixture=None):
    root = folder / ("uterm-native-qa-" + mode)
    root.mkdir()
    source_info = plistlib.loads((source / "Contents/Info.plist").read_bytes())
    personal = source_info.get("UTermBuildFlavor") == "personal"
    identity = ("sh.uterm.desktop.qa.native.personal.update." if personal else "sh.uterm.desktop.qa.native.update.") + uuid.uuid4().hex
    # Refuse an existing SDK profile; cleanup is limited to this newly generated identity.
    # 拒绝已有 SDK 配置，清理仅限本次新建标识。
    cache = Path.home() / "Library/Caches" / identity
    preferences = Path.home() / "Library/Preferences" / (identity + ".plist")
    assert not cache.exists() and not preferences.exists()
    key = root / "private-key"
    public = root / "public-key"
    run("swift", "-e", """
import Foundation
import CryptoKit
let key = Curve25519.Signing.PrivateKey()
try key.rawRepresentation.base64EncodedString().write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8)
try key.publicKey.rawRepresentation.base64EncodedString().write(toFile: CommandLine.arguments[2], atomically: true, encoding: .utf8)
""", key, public)
    key.chmod(0o600)
    public_key = public.read_text()
    assert len(base64.b64decode(public_key, validate=True)) == 32
    requests = []
    archive = root / "update.zip"
    signature = ""
    case_dir = evidence / mode; case_dir.mkdir()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *arguments):
            pass

        def do_GET(self):
            retry = (root / "retry-enabled").exists()
            if mode == "automatic" and not (root / "automatic-opt-in").exists():
                requests.append({"path": self.path, "beforeOptIn": True})
                self.send_error(503)
                return
            if self.path == "/appcast.xml":
                if mode == "offline" and not retry:
                    self.send_error(503)
                    requests.append({"path": self.path, "status": 503})
                    return
                version = "0" if mode == "old-version" else "2"
                channel = "preview" if mode == "wrong-channel" else "stable"
                architecture = "x86_64" if platform.machine() == "arm64" else "arm64"
                if mode != "wrong-arch":
                    architecture = platform.machine()
                sig = signature
                if mode == "bad-signature":
                    value = bytearray(base64.b64decode(sig)); value[0] ^= 1
                    sig = base64.b64encode(value).decode()
                body = f'''<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:uterm="https://uterm.invalid/test-updates"><channel><title>Isolated SDK test</title><item>
<title>QA update</title><sparkle:channel>{channel}</sparkle:channel><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
<uterm:platform>macos</uterm:platform><uterm:architecture>{architecture}</uterm:architecture>
<enclosure url="http://127.0.0.1:{self.server.server_port}/update.zip" sparkle:version="{version}" sparkle:shortVersionString="0.0.2" sparkle:edSignature="{sig}" length="{archive.stat().st_size}" type="application/octet-stream"/>
</item></channel></rss>'''.encode()
                (case_dir / "served-appcast.xml").write_bytes(body)
                self.send_response(200); self.send_header("Content-Type", "application/rss+xml")
                self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
                requests.append({"path": self.path, "status": 200})
            elif self.path == "/update.zip":
                data = archive.read_bytes()
                start = 0
                if retry and self.headers.get("Range", "").startswith("bytes="):
                    start = int(self.headers["Range"].split("=")[1].split("-")[0])
                status = 206 if start else 200
                self.send_response(status)
                if start: self.send_header("Content-Range", f"bytes {start}-{len(data)-1}/{len(data)}")
                self.send_header("Content-Length", str(len(data)-start)); self.end_headers()
                interrupted = mode == "interrupted" and not retry
                limit = min(len(data), 131072) if interrupted else len(data)
                sent = 0
                try:
                    for offset in range(start, limit, 65536):
                        chunk = data[offset:min(offset+65536, limit)]
                        self.wfile.write(chunk); self.wfile.flush(); sent += len(chunk); time.sleep(0.001)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                requests.append({"path": self.path, "status": status, "bytes": sent, "interrupted": interrupted})
                if interrupted:
                    self.close_connection = True
                    try: self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
            else:
                self.send_error(404)

    server = LoopbackHTTPServer(Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        app = root / "Private Applications" / source.name
        app.parent.mkdir()
        info = source_info.copy()
        info.update(CFBundleIdentifier=identity, UTermQADataRoot=str(root), UTermUpdateTestMode=mode,
                    CFBundleVersion="1", CFBundleShortVersionString="0.0.1",
                    UTermUpdateFeedURL=f"http://127.0.0.1:{server.server_port}/appcast.xml",
                    UTermUpdateChannel="stable", SUPublicEDKey=public_key, SUVerifyUpdateBeforeExtraction=True)
        if mode == "install" or personal: info["UTermQAUpdateReport"] = str(case_dir / "sdk-native.json")
        if personal:
            info.update(UTermUpdateMode="automatic", SUAllowsAutomaticUpdates=True)
        configure_app(source, app, info)
        payload = root / "payload" / source.name
        payload.parent.mkdir()
        updated = {**info, "CFBundleVersion": "2", "CFBundleShortVersionString": "0.0.2"}
        configure_app(source, payload, updated)
        run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", payload, archive)
        signature = run("env", f"PERSONAL_UPDATER_PUBLIC_KEY={public_key}", "node", "scripts/personal-updates.mjs", "sign", archive, key).decode().strip()
        assert len(base64.b64decode(signature, validate=True)) == 64
        run(signer, "--verify", "--ed-key-file", key, archive, signature)
        report = case_dir / "sdk-native.json"
        process = None
        try:
            with (case_dir / "stdout.log").open("w") as out, (case_dir / "stderr.log").open("w") as err:
                environment = dict(os.environ)
                if database_fixture:
                    environment["UTERM_QA_DATABASE_FIXTURE"] = str(database_fixture)
                process = subprocess.Popen([str(app / "Contents/MacOS" / info["CFBundleExecutable"]), "--qa-data-root", str(root), "--updates-smoke-report", str(report)], stdout=out, stderr=err, env=environment)
                code = process.wait(timeout=300 if mode == "install" else 220)
            if mode == "install":
                deadline = time.monotonic() + 120
                handled = False
                while not report.exists() and time.monotonic() < deadline:
                    request_path = case_dir / "capture-request.json"
                    if request_path.exists() and not handled:
                        handled = True
                        response = {"passed": False}
                        try:
                            request = json.loads(request_path.read_text())
                            validate_capture_request(request, head, tested, identity, process.pid)
                            ownership = json.loads(run(capture_tool, request["pid"], request["windowNumber"], case_dir / request["screenshot"], timeout=30))
                            assert ownership["ownerPID"] == request["pid"] and ownership["windowNumber"] == request["windowNumber"]
                            ownership.update(sourceHeadSHA=head, testedMergeSHA=tested, platform="macOS", architecture=platform.machine())
                            (case_dir / "capture-ownership.json").write_text(json.dumps(ownership, indent=2)+"\n")
                            response["passed"] = True
                        except Exception as error:
                            response["failure"] = str(error)
                        temporary = case_dir / "capture-response.tmp"
                        temporary.write_text(json.dumps(response)+"\n")
                        temporary.replace(case_dir / "capture-response.json")
                    time.sleep(.1)
            data = json.loads(report.read_text())
            assert code == 0 and "failure" not in data and "cleanupError" not in data, data.get("failure", data.get("cleanupError", code))
            assert data["sourceHeadSHA"] == head and data["sourceSHA"] == tested
            assert data["defaultAutomaticUpdatesOff"] and data["realPTYRetainedGenerationAndHost"]
            assert data["realSparkleSDK"] == "2.10.1" and data["simulatedUserDriver"]
            assert not data["productionDataAccess"] and not data["productionFeedChanged"]
            assert data["actualInstallOrRelaunchExecuted"] == (mode == "install")
            if mode == "automatic" and personal:
                assert data["personalAutomaticDownloadsEnabled"] and data["backgroundUpdatePreparedForQuit"]
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if plistlib.loads((app / "Contents/Info.plist").read_bytes())["CFBundleVersion"] == "2":
                        break
                    time.sleep(.1)
                else:
                    raise AssertionError("Automatic download did not install the verified update on ordinary exit")
                data["actualAutomaticInstallOnQuitExecuted"] = True
                data["actualInstallOrRelaunchExecuted"] = True
            if mode == "install":
                assert data["retainedTerminalVisibleInRelaunchedWindow"] is True
                for field in ["actualPostgreSQLQueryQuitRefused", "actualTransactionQuitRefused", "rollbackRetainedOriginalData",
                              "simulatedTransferWorkerState", "actualKeepWindowOpenButton", "actualApplicationTerminationDelegate",
                              "updateTerminationRequestSimulated", "sameHostAndGeneration"]:
                    assert data["quitGuards"][field] is True, field
            if mode == "install":
                assert data["actualEditorQuitAutosaveRetainedBytes"] and data["explicitFixtureCloseAndIdleHostShutdown"]
                assert data["originalAppPID"] == process.pid and data["relaunchedAppPID"] != process.pid
                assert data["oldBundleVersion"] == "1" and data["installedBundleVersion"] == "2"
                assert plistlib.loads((app / "Contents/Info.plist").read_bytes())["CFBundleVersion"] == "2"
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if subprocess.run(["ps", "-p", str(data["relaunchedAppPID"]), "-o", "pid="], capture_output=True).returncode != 0: break
                    time.sleep(.1)
                else: raise AssertionError("Relaunched QA app did not complete ordinary exit")
                data["relaunchedProcessExited"] = True
                data["relaunchedProcessExitCode"] = None
                # Observe the owned process/endpoint without starting another host during cleanup.
                # 清理时仅观察本次拥有的进程／端点，不再启动另一个宿主。
                data["hostExit"] = json.loads(run("node", "--input-type=module", "-e", """
import { pathToFileURL } from 'node:url';
const { waitForOwnedHostExit } = await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(JSON.stringify(await waitForOwnedHostExit(process.argv[2], Number(process.argv[3]), 20000)));
""", Path(__file__).with_name("owned-host-exit.mjs").resolve(), root / "local-daemon-v1/endpoint.json", data["hostPIDAfter"], timeout=25))
                assert data["hostExit"]["endpointRemoved"] and data["hostExit"]["hostPIDExited"]
                data["retainedHostProcessExited"] = True
                assert not (root / "local-daemon-v1/endpoint.json").exists()
            assert all((case_dir / name).stat().st_size > 1000 for name in data["captures"])
            assert requests and all(item["path"] in ("/appcast.xml", "/update.zip") for item in requests)
            if mode in ("old-version", "wrong-channel", "wrong-arch"):
                assert not any(item["path"] == "/update.zip" for item in requests)
            if mode in ("offline", "interrupted"): assert data["actualSDKRetryReachedReady"]
            if mode == "automatic":
                assert data["actualSDKAutomaticSchedulingAndOptOut"]
                assert data["completedSDKCycleAndSchedulingBeforeOptOut"]
                assert not any(item.get("beforeOptIn") for item in requests)
            data.update(passed=True, testedMergeSHA=tested, sourceTreeDirty=False, processExitCode=code,
                        archiveSHA256=hashlib.file_digest(archive.open("rb"), "sha256").hexdigest(),
                        updateSignature=signature, publicTestKey=public_key, fixtureMode=mode,
                        packageFlavor="personal" if personal else "qa", nodeSignatureVerifiedByOfficialSparkleTool=True)
            report.write_text(json.dumps(data, ensure_ascii=False, indent=2)+"\n")
            if mode in ("good", "install"): shutil.copyfile(archive, case_dir / "signed-test-update.zip")
            return {"mode": mode, "passed": True, "report": mode + "/sdk-native.json",
                    "actualInstallOrRelaunchExecuted": data["actualInstallOrRelaunchExecuted"],
                    "actualAutomaticInstallOnQuitExecuted": data.get("actualAutomaticInstallOnQuitExecuted", False)}
        finally:
            if process and process.poll() is None: process.kill(); process.wait()
            if mode == "install":
                cleanup = run("swift", "-e", "import AppKit; for app in NSRunningApplication.runningApplications(withBundleIdentifier: CommandLine.arguments[1]) { print(app.processIdentifier); app.forceTerminate() }", identity).decode().strip()
                (case_dir / "relaunched-app-cleanup.json").write_text(json.dumps({"identity": identity, "forcedRemainingQAProcessIDs": cleanup.splitlines()}))
            if (root / "local-daemon-v1/endpoint.json").exists():
                target = Path(os.environ.get("CARGO_TARGET_DIR", "crates/uterm-core/target")).resolve()
                with (case_dir / "host-cleanup.log").open("w") as log:
                    helper = subprocess.Popen([str(target / "debug/uterm-core-contract"), "--serve", str(root / "shared-state-v1")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
                    def call(method, params=None):
                        helper.stdin.write(json.dumps(dict(version=1, id="update-qa-cleanup", method=method, params=params))+"\n"); helper.stdin.flush()
                        reply = json.loads(helper.stdout.readline()); assert "error" not in reply, reply
                        return reply.get("result")
                    try:
                        call("host.configure", {"helper": str(source / "Contents/Resources/bin/utermd-local")})
                        for session in call("host.status")["sessions"]: call("host.close", {"id": session["spec"]["id"], "generation": session["generation"]})
                        call("host.shutdownIdle")
                    finally:
                        helper.stdin.close()
                        try: helper.wait(timeout=10)
                        except subprocess.TimeoutExpired: helper.kill(); helper.wait(); raise
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=5)
        (case_dir / "http-requests.json").write_text(json.dumps(requests, indent=2)+"\n")
        # The private seed never enters reports, application bundles or CI artifacts.
        # 私有种子绝不进入报告、应用包或 CI 产物。
        key.unlink(missing_ok=True)
        subprocess.run(["defaults", "delete", identity], capture_output=True)
        if cache.exists(): shutil.rmtree(cache)
        preferences.unlink(missing_ok=True)


def main():
    from database_qa_service import DatabaseService
    parser = argparse.ArgumentParser()
    parser.add_argument("--personal", action="store_true")
    args = parser.parse_args()
    assert platform.system() == "Darwin"
    source = Path("macos/.build/personal/uTerm Personal.app" if args.personal else "macos/.build/qa/UTermNativeQA.app").resolve()
    evidence = Path("macos/.build/personal-packages/updates" if args.personal else "macos/.build/evidence/updates").resolve(); evidence.mkdir(parents=True, exist_ok=True)
    tested = run("git", "rev-parse", "HEAD").decode().strip()
    head = os.environ.get("PR_HEAD_SHA", tested)
    assert not run("git", "status", "--porcelain").strip()
    results = []
    with tempfile.TemporaryDirectory(prefix="uterm-native-qa-updates-") as temporary:
        folder = Path(temporary).resolve()
        toolkit = folder / "sparkle.tar.xz"
        for attempt in range(3):
            try:
                with urllib.request.urlopen(TOOLKIT_URL, timeout=60) as response, toolkit.open("wb") as stream:
                    total = 0
                    while chunk := response.read(1024 * 1024):
                        total += len(chunk)
                        assert total <= 64 * 1024 * 1024, "Unexpected SDK toolkit size"
                        stream.write(chunk)
                break
            except (OSError, urllib.error.URLError):
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
        assert hashlib.file_digest(toolkit.open("rb"), "sha256").hexdigest() == TOOLKIT_SHA256
        signer = folder / "sign_update"
        with tarfile.open(toolkit) as archive:
            signer.write_bytes(archive.extractfile("./bin/sign_update").read())
        signer.chmod(0o700)
        capture_tool = folder / "owned-window-capture"
        run("xcrun", "swiftc", Path("scripts/macos-owned-window-capture.swift").resolve(), "-o", capture_tool)
        for mode in ("good", "bad-signature", "wrong-arch", "wrong-channel", "old-version", "cancel", "offline", "interrupted", "automatic", "install"):
            try:
                if mode == "install":
                    service = DatabaseService(folder, evidence / "database-service")
                    try:
                        service.start()
                        result = exercise(source, folder, evidence, signer, mode, head, tested, capture_tool, service.context)
                        assert service.sql("SELECT note FROM qa_exact WHERE id=1") == "ORIGINAL_DATABASE_TEXT"
                        assert service.sql("SELECT count(*) FROM pg_stat_activity WHERE usename='uterm_qa' "
                                           "AND pid<>pg_backend_pid() AND backend_type='client backend'") == "0"
                        service.verified = result["passed"]
                        service.report.update(rollbackRetainedOriginalData=True, noRemainingClientConnections=True)
                    finally:
                        service.close()
                    results.append(result)
                else:
                    results.append(exercise(source, folder, evidence, signer, mode, head, tested, capture_tool))
            except Exception as error:
                item = {"mode": mode, "passed": False, "failure": str(error)}
                case_report = evidence / mode / "sdk-native.json"
                if case_report.exists():
                    actual = json.loads(case_report.read_text())
                    if actual.get("sourceHeadSHA") == head and actual.get("sourceSHA") == tested:
                        item["actualInstallOrRelaunchExecuted"] = actual.get("actualInstallOrRelaunchExecuted", False)
                results.append(item)
    result = dict(passed=all(item["passed"] for item in results), sourceHeadSHA=head, testedMergeSHA=tested,
                  sourceTreeDirty=False, platform="macOS", architecture=platform.machine(), system=platform.mac_ver()[0],
                  sdk="2.10.1", toolkitSHA256=TOOLKIT_SHA256, scenarios=results, packageFlavor="personal" if args.personal else "qa",
                  toolchain=dict(swift=run("xcrun", "swift", "--version").decode().strip(), xcode=run("xcodebuild", "-version").decode().strip(), rust=run("rustc", "--version").decode().strip()),
                  simulatedUserDriver=True, actualInstallOrRelaunchExecuted=any(item.get("actualInstallOrRelaunchExecuted", False) for item in results),
                  actualInstallationAccepted=any(item["mode"] == "install" and item["passed"] for item in results), productionFeedChanged=False,
                  remaining=["Transfer worker states and requests to the actual application termination delegate are explicitly simulated; PostgreSQL and final SDK installation are real"])
    (evidence / "sdk-summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n")
    print(json.dumps(result, ensure_ascii=False))
    if not result["passed"]: raise SystemExit(1)


if __name__ == "__main__":
    main()
