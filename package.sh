#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$script_directory"

if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js is required. Install Node.js 22.13 or later and retry.' >&2
  exit 127
fi

exec node "$script_directory/scripts/package.mjs" "$@"
