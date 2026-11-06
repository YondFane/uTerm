"""Prepare a historical client with a recorded, isolated QA overlay.
使用有记录的隔离 QA 注入准备历史客户端。
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(destination, evidence):
    destination, evidence = Path(destination), Path(evidence)
    fixture = json.loads(Path("shared/fixtures/client-upgrade.json").read_text(encoding="utf-8"))
    baseline = fixture["baselineRelease"]
    assert re.fullmatch(r"[0-9a-f]{40}", baseline)
    if subprocess.run(["git", "cat-file", "-e", baseline+"^{commit}"], capture_output=True).returncode:
        subprocess.run(["git", "fetch", "--no-tags", "--depth=1", "origin", baseline], check=True)
    destination.mkdir(parents=True, exist_ok=False)
    evidence.mkdir(parents=True, exist_ok=True)
    archive = destination.parent / "historical-source.tar"
    subprocess.run(["git", "archive", "--format=tar", "--output="+str(archive.resolve()), baseline], check=True)
    with tarfile.open(archive) as source:
        source.extractall(destination, filter="data")
    before = {str(path.relative_to(destination)): digest(path) for path in destination.rglob("*") if path.is_file()}
    main = destination / "src/main.tsx"
    text = main.read_text(encoding="utf-8")
    marker = "suppressBrowserContextMenu(window);"
    assert text.count(marker) == 1
    header, body = text.split(marker)
    main.write_text('import { seedLegacyTransition, runLegacyTransition } from "./qa-legacy-transition";\n'
                    + header + "async function launchLegacyQA() {\nawait seedLegacyTransition();\n"
                    + marker + body + "\nvoid runLegacyTransition();\n}\nvoid launchLegacyQA();\n", encoding="utf-8")
    rust = destination / "src-tauri/src/main.rs"
    text = rust.read_text(encoding="utf-8")
    marker = "use tauri::{Emitter, Manager};"
    assert text.count(marker) == 1 and text.count("tauri::generate_handler![") == 1
    text = text.replace(marker, marker+"\nmod qa_legacy_transition;")
    text = text.replace("tauri::generate_handler![", "tauri::generate_handler![\n"
                        "qa_legacy_transition::qa_legacy_context,\nqa_legacy_transition::qa_legacy_host,\n"
                        "qa_legacy_transition::qa_legacy_export,\nqa_legacy_transition::qa_legacy_capture_ack,\n"
                        "")
    rust.write_text(text, encoding="utf-8")
    copies = {
        "src/qa-legacy-transition.ts": "scripts/fixtures/legacy-transition.ts",
        "src-tauri/src/qa_legacy_transition.rs": "scripts/fixtures/legacy-transition-bridge.rs",
    }
    for target, original in copies.items():
        (destination / target).write_bytes(Path(original).read_bytes())
    changed = {name: {"originalSHA256": original, "overlaySHA256": digest(destination / name)}
               for name, original in before.items() if digest(destination / name) != original}
    assert set(changed) == {"src/main.tsx", "src-tauri/src/main.rs"}, changed
    report = dict(baselineRelease=baseline, sourceArchiveSHA256=digest(archive),
                  publishedInstallerBinary=False, historicalApplicationWithLabelledQAOverlay=True,
                  changedOriginalFiles=changed, addedFiles={name: digest(destination / name) for name in copies},
                  originalSourceHashes=before,
                  overlayScope="Only seed/run QA around the original React entry, register private QA commands, and override build identity; original readers, GUI, services, dependencies and lockfiles remain unchanged")
    (evidence / "historical-source-overlay.json").write_text(json.dumps(report, indent=2)+"\n", encoding="utf-8")
    return report


def verify_originals(destination, report):
    changed = report["changedOriginalFiles"]
    for name, original in report["originalSourceHashes"].items():
        expected = changed[name]["overlaySHA256"] if name in changed else original
        assert digest(Path(destination) / name) == expected, "Historical source changed during build: " + name
    for name, expected in report["addedFiles"].items():
        assert digest(Path(destination) / name) == expected, "Historical QA overlay changed during build: " + name
