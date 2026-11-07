#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
performance_os="${RUNNER_OS:-$(uname -s)}"
for round in 1 2 3; do
  export UTERM_QA_PERFORMANCE_LONG=0
  if [[ "$round" == 3 ]]; then export UTERM_QA_PERFORMANCE_LONG=1; fi
  if [[ "$performance_os" == macOS || "$performance_os" == Darwin ]]; then
    node scripts/macos-performance-smoke.mjs
    mv ci-evidence/performance-native "ci-evidence/performance/native-$round"
  fi
  if [[ "$round" == 1 ]]; then
    UTERM_QA_PERFORMANCE_ONLY=1 node scripts/tauri-state-qa.mjs
  else
    UTERM_QA_PERFORMANCE_ONLY=1 node scripts/tauri-state-qa.mjs --skip-build
  fi
  mv ci-evidence/tauri-state-qa "ci-evidence/performance/tauri-$round"
done
