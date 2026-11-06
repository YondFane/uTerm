"""Record database protocol simulation separately from real-server acceptance.
将数据库协议模拟结果与真实服务验收分开记录。
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import urllib.request

output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=True)
catalog = json.loads(Path("components/database/catalog.json").read_text())
target = Path("components/database/target/mongodb")
target.mkdir(parents=True, exist_ok=True)
drivers = []
for key, name in [("mongodb", "mongodb-driver-sync"),
                  ("mongodb-core", "mongodb-driver-core"), ("mongodb-bson", "bson")]:
    artifact = catalog["drivers"][key]
    destination = target / (name + ".jar")
    with urllib.request.urlopen(artifact["url"], timeout=60) as response:
        payload = response.read(artifact["size"] + 1)
    assert len(payload) == artifact["size"], "Catalog driver size mismatch"
    assert hashlib.sha256(payload).hexdigest() == artifact["sha256"], "Catalog driver digest mismatch"
    destination.write_bytes(payload)
    drivers.append({"id": key, "version": artifact["version"], "sha256": artifact["sha256"]})
for key in ["mysql", "postgresql", "oracle"]:
    artifact = catalog["drivers"][key]
    with urllib.request.urlopen(artifact["url"], timeout=60) as response:
        payload = response.read(artifact["size"] + 1)
    assert len(payload) == artifact["size"] and hashlib.sha256(payload).hexdigest() == artifact["sha256"]
    (target.parent / (key + ".jar")).write_bytes(payload)
    drivers.append({"id": key, "version": artifact["version"], "sha256": artifact["sha256"]})
files = sorted(str(path) for path in Path("tests").glob("database*.test.mjs"))
files += ["tests/document-database.test.mjs", "tests/native-database.test.mjs"]
command = ["node", "--experimental-strip-types", "--test", "--test-concurrency=1",
           "--test-reporter=tap", *files]
with (output / "database-simulated-tests.log").open("w", encoding="utf-8") as log:
    result = subprocess.run(command, env=dict(os.environ, UTERM_DATABASE_JAVA_TEST="1",
                                             UTERM_MONGODB_DRIVER_TEST="1", UTERM_DATABASE_PROXY_TEST="1"),
                            stdout=log, stderr=subprocess.STDOUT, timeout=240)
text = (output / "database-simulated-tests.log").read_text(encoding="utf-8")
counts = {key: int(re.search(r"^# " + key + r" (\d+)$", text, re.M).group(1))
          for key in ["tests", "pass", "fail", "skipped"]}
head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
report = {
    "sourceHeadSHA": os.environ.get("PR_HEAD_SHA", head), "testedMergeSHA": head,
    "sourceTreeDirty": bool(subprocess.check_output(["git", "status", "--porcelain"], text=True)),
    "platform": platform.platform(), "architecture": platform.machine(),
    "command": command, "drivers": drivers, "counts": counts,
    "validationMode": "isolated protocol and component simulation",
    "mongoServer": "disposable wire fixture using the real pinned MongoDB Java driver",
    "mysqlOracle": "dialect guards and shared SQL/configuration/component simulations; not real vendors",
    "elasticsearch": "HTTP protocol/component simulations; not a real vendor cluster",
    "realVendorAcceptance": False, "manualAcceptance": "waived by user",
    "passed": result.returncode == 0 and counts["fail"] == 0,
}
(output / "database-simulated.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
if not report["passed"]:
    raise SystemExit(result.returncode or 1)
