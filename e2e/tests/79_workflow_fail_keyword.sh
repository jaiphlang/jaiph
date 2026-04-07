#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "workflow_fail_keyword"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "workflow fail keyword exits non-zero and prints message on stderr"

e2e::file "failme.jh" <<'EOF'
workflow default() {
  fail "contract-break"
}
EOF

set +e
out="$(e2e::run "failme.jh" 2>&1)"
code=$?
set -e

[[ ${code} -ne 0 ]] || e2e::fail "expected non-zero exit from fail step"
# assert_contains: FAIL output includes absolute run-dir paths and timestamps which vary per invocation
e2e::assert_contains "${out}" "contract-break" "stderr contains fail message"
