#!/usr/bin/env python3
import hashlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

root = Path(__file__).resolve().parent.parent
source = root / "crates/utermd-local/src/java_utf8/Java8EncodingAgent.java"
target = source.with_name("agent.rs")
home = Path(os.environ["JAVA_HOME"])
with tempfile.TemporaryDirectory(prefix="uterm-agent-build-") as temporary:
    output = Path(temporary)
    subprocess.run(
        [str(home / "bin" / ("javac.exe" if os.name == "nt" else "javac")),
         "--release", "8", "-g:none", "-Xlint:-options", "-d", str(output), str(source)],
        check=True,
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        files = {"META-INF/MANIFEST.MF": b"Manifest-Version: 1.0\r\nPremain-Class: uterm.compat.Java8EncodingAgent\r\n\r\n"}
        for file in sorted(output.rglob("*.class")):
            data = file.read_bytes()
            assert data[:4] == b"\xca\xfe\xba\xbe" and int.from_bytes(data[6:8], "big") == 52
            files[file.relative_to(output).as_posix()] = data
        for name, data in files.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
    data = buffer.getvalue()
    digest = hashlib.sha256(source.read_text(encoding="utf-8").encode()).hexdigest()
    lines = ["// Embedded Java 8 runtime agent; regenerate with scripts/java8-encoding-agent.py and JDK 21.",
             "// 内嵌 Java 8 运行时 Agent；使用 JDK 21 和 scripts/java8-encoding-agent.py 重新生成。",
             f"// Source SHA-256 / 源码 SHA-256: {digest}",
             "pub(super) const JAR: &[u8] = &["]
    for offset in range(0, len(data), 16):
        lines.append("    " + " ".join(f"0x{value:02x}," for value in data[offset:offset + 16]))
    lines.append("];")
    content = "\n".join(lines) + "\n"
    if "--check" in sys.argv:
        assert target.read_text(encoding="utf-8") == content, "Embedded Java 8 agent differs; regenerate it with JDK 21"
    else:
        target.write_text(content, encoding="utf-8")
    print(f"Java 8 encoding agent: {len(data)} bytes, source {digest}")
