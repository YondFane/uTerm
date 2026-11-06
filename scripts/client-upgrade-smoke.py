"""Run a historical Tauri → native → historical Tauri rehearsal in owned Mac profiles.
在自有 Mac 配置中演练历史 Tauri → 原生 → 历史 Tauri。
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import plistlib
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import uuid


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(*args, cwd=None, env=None, timeout=120, log=None, check=True):
    if log:
        with Path(log).open("wb") as stream:
            result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, stdout=stream,
                                    stderr=subprocess.STDOUT, timeout=timeout)
    else:
        result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(str(args[0])+" failed; see "+(str(log) if log else result.stderr.decode(errors="replace")[:1000]))
    return result


def write(path, value):
    path = Path(path)
    stage = path.with_suffix(path.suffix+".pending")
    stage.write_text(json.dumps(value, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    stage.replace(path)


def tree_digest(root):
    root = Path(root).resolve()
    values = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            assert path.resolve().is_relative_to(root), "Package symlink leaves its owned application"
            values[str(path.relative_to(root))] = "link:"+os.readlink(path)
        elif path.is_file():
            values[str(path.relative_to(root))] = digest(path)
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def owned_programs(installed, staged, previous):
    base = Path(installed).parent.resolve()
    owner = base.parent
    assert owner.parent == Path(tempfile.gettempdir()).resolve() and owner.name.startswith("uterm-native-qa-transition-")
    for path in [installed, staged, previous]:
        assert Path(path).parent.resolve() == base and not Path(path).is_symlink()


def replace_program(installed, staged, previous, interrupt=False):
    installed, staged, previous = Path(installed), Path(staged), Path(previous)
    owned_programs(installed, staged, previous)
    assert installed.is_dir() and staged.is_dir() and not previous.exists()
    write(installed.parent / "swap-journal.json", dict(stage="prepared", previousHash=tree_digest(installed)))
    installed.rename(previous)
    if interrupt:
        raise InterruptedError("Deliberate QA interruption after moving the old program")
    staged.rename(installed)
    write(installed.parent / "swap-journal.json", dict(stage="installed", previousHash=tree_digest(previous), installedHash=tree_digest(installed)))


def recover_program(installed, staged, previous):
    owned_programs(installed, staged, previous)
    journal = json.loads((Path(installed).parent / "swap-journal.json").read_text())
    assert not Path(installed).exists() and Path(previous).is_dir()
    assert tree_digest(previous) == journal["previousHash"]
    Path(previous).rename(installed)
    write(Path(installed).parent / "swap-journal.json", dict(stage="recovered", restoredHash=tree_digest(installed)))


class Core:
    def __init__(self, binary, root, helper, evidence):
        self.log = (evidence / "core.log").open("wb")
        self.process = subprocess.Popen([str(binary), "--serve", str(root)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.log, text=True, encoding="utf-8")
        self.replies = queue.Queue()
        def read():
            for line in self.process.stdout:
                self.replies.put(line)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        self.call("host.configure", dict(helper=str(helper)))

    def call(self, method, params=None):
        for attempt in range(20):
            self.process.stdin.write(json.dumps(dict(version=1, id="transition", method=method, params=params), ensure_ascii=False)+"\n")
            self.process.stdin.flush()
            reply = json.loads(self.replies.get(timeout=40))
            error = reply.get("error")
            if error:
                if error["code"] == "WRITER_BUSY" and method in ["snapshot.read", "editor.drafts.read", "rollback.export", "host.status"] and attempt < 19:
                    time.sleep(.05)
                    continue
                raise AssertionError(method+": "+str(error))
            return reply.get("result")

    def close(self):
        self.process.stdin.close()
        try:
            assert self.process.wait(timeout=15) == 0
        except BaseException:
            self.process.kill(); self.process.wait()
            raise
        finally:
            self.log.close()


def wait_report(path, process, timeout=100):
    deadline = time.monotonic()+timeout
    while time.monotonic() < deadline:
        if Path(path).exists():
            value = json.loads(Path(path).read_text(encoding="utf-8"))
            assert not value.get("failure") and value.get("passed", True), value
            return value
        assert process.poll() is None, "Application exited before writing its report"
        time.sleep(.1)
    raise TimeoutError("Owned application did not produce "+str(path))


def capture(tool, pid, path):
    for attempt in range(30):
        result = run(tool, pid, 0, path, check=False)
        if result.returncode == 0:
            metadata = json.loads(result.stdout)
            assert metadata["ownerPID"] == pid and metadata["windowNumber"] > 0
            assert Path(path).read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
            write(str(path)+".ownership.json", metadata)
            return
        detail = result.stderr.decode(errors="replace")[:4000]
        if result.returncode != 4:
            raise AssertionError("Owned window capture failed: "+str(result.returncode)+" "+detail)
        time.sleep(.1)
    raise AssertionError("No unique owned window was ready: "+detail)


def historical_run(installed, root, evidence, tool, label):
    info = plistlib.loads((installed / "Contents/Info.plist").read_bytes())
    context = json.loads((root / "legacy-input.json").read_text())
    context["markerSuffix"] = uuid.uuid4().hex
    write(root / "legacy-input.json", context)
    phase = context["phase"]
    report = root / ("legacy-"+phase+".json")
    report.unlink(missing_ok=True)
    ack = root / ("legacy-"+phase+".capture-ack")
    ack.unlink(missing_ok=True)
    with (evidence / (label+".stdout.log")).open("wb") as out, (evidence / (label+".stderr.log")).open("wb") as err:
        process = subprocess.Popen([str(installed / "Contents/MacOS" / info["CFBundleExecutable"])], stdout=out, stderr=err)
        try:
            value = wait_report(report, process)
            assert value["pid"] == process.pid and value["publishedInstallerBinary"] is False
            write(evidence / (label+"-checkpoint.json"), value)
            image = label+".png"
            capture(tool, process.pid, evidence / image)
            ack.write_text("owned window captured\n")
            process.kill()
            assert process.wait(timeout=15) == -9, "Historical UI crash was not observed"
            value["actualUIForcedExitAfterDurableExport"] = True
            value["screenshot"] = image
            write(evidence / (label+".json"), value)
            return value
        except BaseException:
            if report.is_file(): shutil.copyfile(report, evidence / (label+"-failed-checkpoint.json"))
            if process.poll() is None:
                try: capture(tool, process.pid, evidence / (label+"-failure.png"))
                except Exception as error:
                    write(evidence / (label+"-failure-capture.json"), dict(error=str(error)))
            raise
        finally:
            if process.poll() is None:
                process.kill(); process.wait()


def native_run(installed, root, evidence, phase, head, tested):
    info = plistlib.loads((installed / "Contents/Info.plist").read_bytes())
    path = evidence / ("native-"+phase+".json")
    with (evidence / ("native-"+phase+".stdout.log")).open("wb") as out, (evidence / ("native-"+phase+".stderr.log")).open("wb") as err:
        process = subprocess.Popen([str(installed / "Contents/MacOS" / info["CFBundleExecutable"]), "--qa-data-root", str(root),
                                    "--transition-smoke-report", str(path), "--transition-smoke-phase", phase], stdout=out, stderr=err)
        try:
            value = wait_report(path, process)
            assert value["sourceHeadSHA"] == head and value["sourceSHA"] == tested
            assert value["bundleIdentifier"] == info["CFBundleIdentifier"] and value["productionDataAccess"] is False
            assert value["realHistoricalHostAndGenerationRetained"] and value["latestDraftBytesDurable"] and value["originalFileUnchanged"]
            for name in value["captures"]:
                assert (evidence / name).read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
            if phase == "checkpoint":
                assert value["awaitingForcedExit"] and value["actualNativeEditorInput"]
                process.kill()
                assert process.wait(timeout=15) == -9
                value["actualSIGKILL"] = True
            else:
                assert value["actualNativeEditorRecovery"] and process.wait(timeout=30) == 0
            value.update(passed=True, testedMergeSHA=tested, sourceTreeDirty=False)
            write(path, value)
            return value
        finally:
            if process.poll() is None:
                process.kill(); process.wait()


def main():
    from legacy_transition_source import prepare, verify_originals
    assert platform.system() == "Darwin", "Historical/native application rehearsal requires a real Mac"
    assert os.environ.get("GITHUB_ACTIONS") == "true", "Historical OS adapters retain fixed development labels; use an owned GitHub Actions Mac"
    assert not run("git", "status", "--porcelain").stdout.strip(), "Use clean committed source"
    tested = run("git", "rev-parse", "HEAD").stdout.decode().strip()
    head = os.environ.get("PR_HEAD_SHA", tested)
    evidence = Path("ci-evidence/client-upgrade").resolve(); evidence.mkdir(parents=True, exist_ok=True)
    fixture = json.loads(Path("shared/fixtures/client-upgrade.json").read_text(encoding="utf-8"))
    native_source = Path("macos/.build/qa/UTermNativeQA.app").resolve()
    target = Path(os.environ.get("CARGO_TARGET_DIR", "crates/uterm-core/target")).resolve()
    binary = target / "debug/uterm-core-contract"
    run("cargo", "build", "--locked", "--manifest-path", "crates/uterm-core/Cargo.toml", "--bin", "uterm-core-contract",
        timeout=900, log=evidence / "current-core-build.log")
    report = dict(passed=False, sourceHeadSHA=head, testedMergeSHA=tested, sourceTreeDirty=False,
                  platform="macOS", architecture=platform.machine(), system=platform.mac_ver()[0],
                  baselineRelease=fixture["baselineRelease"], publishedInstallerBinary=False,
                  historicalApplicationWithLabelledQAOverlay=True, productionDataAccess=False,
                  productionFeedChanged=False, cleanupErrors=[], scenarios=[])
    report["toolchain"] = {"rust":run("rustc", "--version").stdout.decode().strip(),
                           "node":run("node", "--version").stdout.decode().strip(),
                           "pnpm":run("pnpm", "--version").stdout.decode().strip(),
                           "swift":run("swift", "--version").stdout.decode().strip(),
                           "xcode":run("xcodebuild", "-version").stdout.decode().strip()}
    links = []
    core = None
    server = None
    server_thread = None
    with tempfile.TemporaryDirectory(prefix="uterm-native-qa-transition-") as temporary:
        root = Path(temporary).resolve()
        identity = "sh.uterm.desktop.qa.native.transition."+uuid.uuid4().hex
        work = Path("layout-qa.local") / ("client-upgrade-"+uuid.uuid4().hex)
        work.mkdir(parents=True)
        source = work / "historical"
        try:
            project = root / "project"; project.mkdir()
            (project / fixture["fileName"]).write_bytes(("\ufeff"+fixture["savedText"]).encode())
            run("git", "-c", "core.hooksPath="+str(root / "no-hooks"), "init", "--quiet", "--initial-branch=main", project)
            run("git", "-C", project, "-c", "core.hooksPath="+str(root / "no-hooks"), "-c", "user.name=uTerm QA",
                "-c", "user.email=uterm-qa@example.invalid", "commit", "--quiet", "--allow-empty", "--no-verify", "--no-gpg-sign", "-m", "Transition fixture")
            for area, destination in [("Application Support", root), ("Caches", root / "cache"), ("WebKit", root / "webkit"), ("HTTPStorages", root / "http")]:
                path = Path.home() / "Library" / area / identity
                assert not path.exists() and not path.is_symlink(), "Refuse an existing application profile"
                destination.mkdir(parents=True, exist_ok=True)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(destination, target_is_directory=True); links.append(path)
            overlay = prepare(source, evidence)
            tag = fixture["baselineTag"]
            remote_tag = run("git", "ls-remote", "--tags", "origin", "refs/tags/"+tag, "refs/tags/"+tag+"^{}").stdout.decode().splitlines()
            peeled = next((line.split()[0] for line in remote_tag if line.endswith("^{}")), None)
            assert (peeled or remote_tag[0].split()[0]) == fixture["baselineRelease"]
            report["publishedReleaseTagVerified"] = tag
            config = work / "historical-config.json"
            write(config, dict(identifier=identity, productName="uTerm Legacy Transition QA", plugins={"deep-link":{"desktop":{"schemes":[]}}},
                               app={"windows":[{"label":"main","title":"uTerm Historical Transition QA","width":1100,"height":720,"visible":True,"focus":True}]}))
            shutil.copyfile(config, evidence / "historical-build-overlay.json")
            report["isolatedBundleIdentifier"] = identity
            env = dict(os.environ, UTERM_QA_TRANSITION_ID=identity, UTERM_QA_TRANSITION_ROOT=str(root),
                       UTERM_QA_TRANSITION_BASELINE=fixture["baselineRelease"], CARGO_TARGET_DIR=str(target))
            run("pnpm", "install", "--frozen-lockfile", cwd=source, timeout=600, log=evidence / "historical-dependencies.log")
            run("pnpm", "check", cwd=source, timeout=180, log=evidence / "historical-types.log")
            run("pnpm", "exec", "tauri", "build", "--debug", "--bundles", "app", "--config", config.resolve(), "--", "--locked", cwd=source,
                env=env, timeout=1800, log=evidence / "historical-build.log")
            verify_originals(source, overlay)
            historical = target / "debug/bundle/macos/uTerm Legacy Transition QA.app"
            assert historical.is_dir()
            apps = root / "Private Applications"; apps.mkdir()
            installed, staged, previous = apps / "uTerm Transition QA.app", apps / "Next.app", apps / "Previous.app"
            run("ditto", historical, installed)
            run("codesign", "--force", "--sign", "-", installed)
            run("codesign", "--verify", "--deep", "--strict", installed)
            info = plistlib.loads((installed / "Contents/Info.plist").read_bytes())
            assert info["CFBundleIdentifier"] == identity
            assert not any("uterm" in item.get("CFBundleURLSchemes", []) for item in info.get("CFBundleURLTypes", []))
            old_hash = tree_digest(installed)
            report["historicalProgramSHA256"] = old_hash
            report["historicalBundleVersion"] = info["CFBundleShortVersionString"]
            assert info["CFBundleShortVersionString"] == "0.2.4"
            run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", installed, evidence / "historical-qa-app.zip")
            core = Core(binary, root / "shared-state-v1", native_source / "Contents/Resources/bin/utermd-local", evidence)
            defaults = core.call("state.defaults")
            workspace = defaults["workspace"]
            project_id = "transition-project"
            workspace["projects"] = [dict(id=project_id, name=fixture["projectName"], directory=str(project), sessions=[], workspaceId="local")]
            workspace["selectedProject"] = project_id
            workspace["groups"][0]["selectedProject"] = project_id
            settings = {**defaults["settings"], "language":"en", "appearance":"dark", "automaticUpdates":False}
            seed = {"uterm.desktop.workspace.v1":json.dumps(workspace, ensure_ascii=False), "uterm.desktop.settings.v1":json.dumps(settings),
                    "uterm.qa.credential.reference":fixture["credentialReference"], "uterm.qa.hook.reference":"fixture-hook-reference-only",
                    "uterm.git.favorites:"+str(project):'["main"]'}
            old_input = dict(phase="before", project=str(project), projectID=project_id, fileName=fixture["fileName"], draftText=fixture["legacyDraft"], seed=seed)
            write(root / "legacy-input.json", old_input)
            capture_tool = root / "capture-owned-window"
            signer = root / "archive-signature"
            run("xcrun", "swiftc", "scripts/macos-owned-window-capture.swift", "-o", capture_tool)
            run("xcrun", "swiftc", "scripts/qa-archive-signature.swift", "-o", signer)
            first = historical_run(installed, root, evidence, capture_tool, "historical-before")
            expected = {name:first["checks"][name] for name in ["id","generation","hostPID"]}
            report["historicalCheckpoint"] = expected
            report["scenarios"].append(dict(name="historical-before", passed=True, report="historical-before.json", screenshot=first["screenshot"]))
            run("ditto", native_source, staged)
            native_info = plistlib.loads((staged / "Contents/Info.plist").read_bytes())
            native_info.update(CFBundleIdentifier=identity, CFBundleExecutable=info["CFBundleExecutable"], CFBundleVersion="0.2.5", CFBundleShortVersionString="0.2.5", UTermQADataRoot=str(root))
            assert not any("uterm" in item.get("CFBundleURLSchemes", []) for item in native_info.get("CFBundleURLTypes", []))
            (staged / "Contents/MacOS/UTermNativeQA").rename(staged / "Contents/MacOS" / info["CFBundleExecutable"])
            (staged / "Contents/Info.plist").write_bytes(plistlib.dumps(native_info))
            run("codesign", "--force", "--sign", "-", staged)
            run("codesign", "--verify", "--deep", "--strict", staged)
            package = evidence / "native-transition.zip"
            run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", staged, package)
            manifest = dict(version="0.2.5", platform="macOS", architecture=platform.machine(), sourceHeadSHA=head,
                            testedMergeSHA=tested, sha256=digest(package), file="native-transition.zip")
            write(evidence / "manifest.json", manifest)
            key, public, signature = root / "private-key", evidence / "manifest.pub", evidence / "manifest.sig"
            run(signer, "generate", evidence / "manifest.json", key, public, signature)
            public_hash = digest(public)
            class Feed(http.server.BaseHTTPRequestHandler):
                def log_message(self, *args): pass
                def do_GET(self):
                    if self.path not in ["/native-transition.zip", "/manifest.json", "/manifest.sig"]:
                        self.send_error(404); return
                    path = evidence / self.path[1:]
                    self.send_response(200); self.send_header("Content-Length", str(path.stat().st_size)); self.end_headers()
                    with path.open("rb") as stream: shutil.copyfileobj(stream, self.wfile)
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Feed)
            server_thread = threading.Thread(target=server.serve_forever, daemon=True); server_thread.start()
            import urllib.request
            for name, limit in [("manifest.json",128*1024),("manifest.sig",1024),("native-transition.zip",256*1024*1024)]:
                with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/{name}", timeout=60) as response, (root / name).open("wb") as stream:
                    length = 0
                    while chunk := response.read(1024*1024):
                        length += len(chunk); assert length <= limit; stream.write(chunk)
            assert digest(public) == public_hash
            run(signer, "verify", root / "manifest.json", key, public, root / "manifest.sig")
            downloaded = json.loads((root / "manifest.json").read_text())
            assert downloaded == manifest and digest(root / "native-transition.zip") == manifest["sha256"]
            extracted = root / "downloaded"
            extracted.mkdir()
            run("ditto", "-x", "-k", root / "native-transition.zip", extracted)
            downloaded_app = extracted / staged.name
            assert tree_digest(downloaded_app) == tree_digest(staged)
            run("codesign", "--verify", "--deep", "--strict", downloaded_app)
            architectures = run("lipo", "-archs", downloaded_app / "Contents/MacOS" / info["CFBundleExecutable"]).stdout.decode().split()
            assert platform.machine() in architectures
            shutil.rmtree(staged); downloaded_app.rename(staged)
            report["installedFromActualVerifiedDownload"] = True
            bad = root / "bad-manifest.json"; bad.write_bytes((root / "manifest.json").read_bytes()+b" ")
            assert run(signer, "verify", bad, key, public, root / "manifest.sig", check=False).returncode != 0
            assert tree_digest(installed) == old_hash
            report["badSignatureRejectedBeforeReplacement"] = True
            report["scenarios"].append(dict(name="verified-private-download-and-invalid-signature-rejection", passed=True, manifest="manifest.json"))
            try: replace_program(installed, staged, previous, interrupt=True)
            except InterruptedError: recover_program(installed, staged, previous)
            assert tree_digest(installed) == old_hash
            recovery_input = json.loads((root / "legacy-input.json").read_text())
            recovery_input["replayMarker"] = first["checks"]["renderedCheckpoint"]
            write(root / "legacy-input.json", recovery_input)
            second = historical_run(installed, root, evidence, capture_tool, "historical-after-interruption")
            assert all(second["checks"][name] == value for name, value in expected.items())
            assert second["checks"]["draft"]["text"] == fixture["legacyDraft"]
            report["actualInterruptedProgramRecoveryAndRestart"] = True
            report["scenarios"].append(dict(name="interrupted-program-recovery", passed=True, report="historical-after-interruption.json", screenshot=second["screenshot"]))
            values = second["values"]
            params = dict(workspace=second["checks"]["workspace"], settings=second["checks"]["settings"], legacy=values)
            snapshot = core.call("migration.import", params)
            assert core.call("migration.import", params) == snapshot
            core.call("editor.drafts.import", {})
            shutil.copytree(root / "shared-state-v1", root / "canonical-before-native")
            shutil.copytree(root / "shared-state-v1", evidence / "canonical-before-native")
            report["repeatMigrationIdempotent"] = True
            report["scenarios"].append(dict(name="repeat-import-and-canonical-backup", passed=True, backup="canonical-before-native"))
            replace_program(installed, staged, previous)
            report["nativeProgramSHA256"] = tree_digest(installed)
            native_input = {**fixture, **expected, "project":str(project)}
            write(root / "transition-native-input.json", native_input)
            for phase in ["checkpoint", "reopen"]:
                native = native_run(installed, root, evidence, phase, head, tested)
                report["scenarios"].append(dict(name="native-"+phase, passed=True, report="native-"+phase+".json", screenshots=native["captures"]))
            snapshot = core.call("snapshot.read")
            drafts = core.call("editor.drafts.read")
            archive = core.call("rollback.export", dict(expectedRevision=snapshot["revision"], expectedDraftRevision=drafts["revision"]))
            assert archive["legacyRequiresDraftChoice"] is False and archive["automaticRestoreAllowed"] is False
            assert json.loads(archive["legacyValues"]["uterm.desktop.editorDraft.v1"])["text"] == fixture["nativeDraft"]
            assert archive["legacyValues"]["uterm.qa.credential.reference"] == fixture["credentialReference"]
            write(evidence / "latest-rollback-archive.json", archive)
            shutil.copytree(root / "shared-state-v1", root / "canonical-before-program-rollback")
            shutil.copytree(root / "shared-state-v1", evidence / "canonical-before-program-rollback")
            before_store = tree_digest(root / "shared-state-v1")
            retained_native = apps / "Retained native.app"
            installed.rename(retained_native); previous.rename(installed)
            assert tree_digest(installed) == old_hash
            write(root / "legacy-input.json", {**old_input, "phase":"rollback", "draftText":fixture["nativeDraft"],
                                               "replayMarker":"TRANSITION_REOPEN",
                                               "seed":archive["legacyValues"], "expected":{**expected,"fontSize":fixture["rollbackFontSize"]}})
            restored = historical_run(installed, root, evidence, capture_tool, "historical-rollback")
            assert restored["checks"]["draft"]["text"].encode() == fixture["nativeDraft"].encode()
            for key in ["uterm.qa.credential.reference", "uterm.qa.hook.reference", "uterm.git.favorites:"+str(project)]:
                assert restored["values"][key] == seed[key]
            assert tree_digest(root / "shared-state-v1") == before_store
            assert (project / fixture["fileName"]).read_bytes() == ("\ufeff"+fixture["savedText"]).encode()
            report["scenarios"].append(dict(name="old-program-and-latest-data-rollback", passed=True, report="historical-rollback.json", screenshot=restored["screenshot"], archive="latest-rollback-archive.json"))
            report.update(passed=True, actualProgramReplacementAndRollback=True, latestDataAppliedInActualHistoricalWebView=True,
                          manualPackageReplacementRehearsal=True, automaticCrossClientFeedConfigured=False,
                          fullCanonicalBackupsRetainedDuringRehearsal=True, sameHostAndGenerationThroughout=True,
                          actualNativeSIGKILLAndRecovery=True, canonicalStoreUnchangedByHistoricalRollback=True,
                          initialDraftInputSimulated=True, osCredentialAndHookReferences="explicit fixtures; actual approval/execution not represented",
                          deepLinksAndLogin="disabled for isolated QA identity; production registration not adopted",
                          packageSHA256=manifest["sha256"], signaturePublicKeySHA256=public_hash,
                          signing="ad-hoc application signatures plus one-time Ed25519 QA manifest; no production signing/notarization")
        except Exception as error:
            report["failure"] = str(error)
            raise
        finally:
            if server: server.shutdown(); server.server_close(); server_thread.join(timeout=5)
            if core:
                try:
                    status = core.call("host.status")
                    for session in status["sessions"]:
                        core.call("host.close", dict(id=session["spec"]["id"], generation=session["generation"]))
                    core.call("host.shutdownIdle")
                    endpoint = root / "local-daemon-v1/endpoint.json"
                    script = "import {waitForOwnedHostExit} from './scripts/owned-host-exit.mjs'; console.log(JSON.stringify(await waitForOwnedHostExit(process.argv[1], Number(process.argv[2]))));"
                    report["hostExit"] = json.loads(run("node", "--input-type=module", "-e", script, endpoint, status["pid"]).stdout)
                    report["explicitSessionCloseAndIdleHostShutdown"] = True
                except Exception as error: report["cleanupErrors"].append(str(error))
                try: core.close()
                except Exception as error: report["cleanupErrors"].append(str(error))
            for link in reversed(links):
                try:
                    assert link.is_symlink(); link.unlink()
                except Exception as error: report["cleanupErrors"].append(str(error))
            run("defaults", "delete", identity, check=False)
            report["privateSigningKeyExcludedFromArtifacts"] = not (evidence / "private-key").exists()
            report["passed"] = report["passed"] and not report["cleanupErrors"]
            write(evidence / "upgrade-rollback.json", report)
    assert report["passed"], "Historical application upgrade/rollback failed; see original reports and logs"


if __name__ == "__main__":
    main()
