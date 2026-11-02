#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
cargo build --locked --manifest-path crates/uterm-ffi/Cargo.toml
native_rust_target="${CARGO_TARGET_DIR:-$PWD/crates/uterm-ffi/target}"
swift test --force-resolved-versions --package-path macos -Xlinker "$native_rust_target/debug/libuterm_ffi.a" -Xlinker -framework -Xlinker Security -Xlinker -framework -Xlinker SystemConfiguration
