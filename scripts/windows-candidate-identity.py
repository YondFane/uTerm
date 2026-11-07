"""Check the exact Tauri NSIS marker transform. 核对 Tauri NSIS 标记变换，其余字节必须完全相同。"""

import hashlib
import json
import sys
from pathlib import Path

UNKNOWN = b"__TAURI_BUNDLE_TYPE_VAR_UNK"
NSIS = b"__TAURI_BUNDLE_TYPE_VAR_NSS"


def compare(built: bytes, installed: bytes) -> dict:
    # Tauri patches this one token for NSIS and restores the original build afterwards.
    # Tauri 为 NSIS 修改这一处标记，打包完成后还原原始构建文件。
    unique = built.count(UNKNOWN) == 1
    expected = built.replace(UNKNOWN, NSIS, 1) if unique else b""
    return {
        "uniqueBundleTypeMarker": unique,
        "unknownBundleTypeMarkers": built.count(UNKNOWN),
        "nsisBundleTypeComparisonConstants": built.count(NSIS),
        "bundleTypeMarkerOffset": built.find(UNKNOWN) if unique else None,
        "expectedNSISBinarySHA256": hashlib.sha256(expected).hexdigest() if unique else None,
        "binaryMatchesExpectedNSIS": unique and installed == expected,
    }


if __name__ == "__main__":
    result = compare(Path(sys.argv[1]).read_bytes(), Path(sys.argv[2]).read_bytes())
    print(json.dumps(result))
