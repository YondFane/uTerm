#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(uname -s)" = Darwin
native_configuration=debug
native_cargo_profile=dev
native_swift_flags=(--scratch-path "$PWD/macos/.build")
case "${1:-qa}" in
  qa) ;;
  personal)
    export MACOSX_DEPLOYMENT_TARGET=14.0
    native_configuration=release
    native_cargo_profile=release
    native_swift_flags=(--scratch-path "$PWD/macos/.build/personal-build" -Xswiftc -DUTERM_PERSONAL)
    ;;
  *) printf 'Usage: %s [qa|personal]\n' "$0" >&2; exit 2 ;;
esac
cargo build --locked --manifest-path crates/uterm-ffi/Cargo.toml --profile "$native_cargo_profile"
native_rust_target="${CARGO_TARGET_DIR:-$PWD/crates/uterm-ffi/target}"
swift test --force-resolved-versions --package-path macos --configuration "$native_configuration" "${native_swift_flags[@]}" -Xlinker "$native_rust_target/$native_configuration/libuterm_ffi.a" -Xlinker -framework -Xlinker Security -Xlinker -framework -Xlinker SystemConfiguration
