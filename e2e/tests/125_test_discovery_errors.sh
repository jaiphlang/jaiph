#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "test_discovery_errors"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ==========================================================================
# Section 1: jaiph test on empty directory — no .test.jh files found
# ==========================================================================

e2e::section "jaiph test: empty directory"

mkdir -p "${TEST_DIR}/empty_dir"

set +e
empty_out="$(jaiph test "${TEST_DIR}/empty_dir" 2>&1)"
empty_exit=$?
set -e

if [[ ${empty_exit} -eq 0 ]]; then
  printf "%s\n" "${empty_out}" >&2
  e2e::fail "jaiph test on empty directory should exit non-zero"
fi
# assert_contains: error message includes varying directory path
e2e::assert_contains "${empty_out}" "no *.test.jh files" \
  "empty directory produces discovery error"

# ==========================================================================
# Section 2: jaiph test on a plain .jh file (not .test.jh)
# ==========================================================================

e2e::section "jaiph test: plain .jh file rejected"

e2e::file "plain.jh" <<'EOF'
workflow default() {
  log "hello"
}
EOF

set +e
plain_out="$(jaiph test "${TEST_DIR}/plain.jh" 2>&1)"
plain_exit=$?
set -e

if [[ ${plain_exit} -eq 0 ]]; then
  printf "%s\n" "${plain_out}" >&2
  e2e::fail "jaiph test on plain .jh should exit non-zero"
fi
# assert_contains: error message includes dynamic file context
e2e::assert_contains "${plain_out}" "requires a *.test.jh file" \
  "plain .jh produces migration hint"

# ==========================================================================
# Section 3: jaiph test on .test.jh file with zero test blocks
# ==========================================================================

e2e::section "jaiph test: zero test blocks"

e2e::file "no_tests.test.jh" <<'EOF'
import "plain.jh" as lib
EOF

set +e
notest_out="$(jaiph test "${TEST_DIR}/no_tests.test.jh" 2>&1)"
notest_exit=$?
set -e

if [[ ${notest_exit} -eq 0 ]]; then
  printf "%s\n" "${notest_out}" >&2
  e2e::fail "jaiph test on .test.jh with no tests should exit non-zero"
fi
# assert_contains: error message includes dynamic file path
e2e::assert_contains "${notest_out}" "must contain at least one test block" \
  "zero test blocks produces error"
