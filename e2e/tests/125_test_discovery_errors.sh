#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "test_discovery_errors"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ==========================================================================
# Section 1: jaiph test on empty directory — exits 0 with notice (discovery)
# ==========================================================================

e2e::section "jaiph test: empty directory"

mkdir -p "${TEST_DIR}/empty_dir"

empty_err="$(mktemp)"
if ! jaiph test "${TEST_DIR}/empty_dir" >/dev/null 2>"${empty_err}"; then
  cat "${empty_err}" >&2
  rm -f "${empty_err}"
  e2e::fail "jaiph test on empty directory should exit 0 in discovery mode"
fi
empty_out="$(cat "${empty_err}")"
rm -f "${empty_err}"

e2e::assert_equals "${empty_out}" \
  "jaiph test: no *.test.jh files found (nothing to do)" \
  "empty directory prints discovery notice on stderr"

# ==========================================================================
# Section 1a: jaiph test (no args) in a workspace without test files
# ==========================================================================

e2e::section "jaiph test: no args in empty workspace"

mkdir -p "${TEST_DIR}/empty_workspace"

noargs_err="$(mktemp)"
if ! (cd "${TEST_DIR}/empty_workspace" && jaiph test >/dev/null 2>"${noargs_err}"); then
  cat "${noargs_err}" >&2
  rm -f "${noargs_err}"
  e2e::fail "jaiph test with no args in empty workspace should exit 0"
fi
noargs_out="$(cat "${noargs_err}")"
rm -f "${noargs_err}"

e2e::assert_equals "${noargs_out}" \
  "jaiph test: no *.test.jh files found (nothing to do)" \
  "no args in empty workspace prints discovery notice"

# ==========================================================================
# Section 1b: jaiph test on nonexistent file — exits non-zero
# ==========================================================================

e2e::section "jaiph test: nonexistent file rejected"

set +e
missing_out="$(jaiph test "${TEST_DIR}/does_not_exist.test.jh" 2>&1)"
missing_exit=$?
set -e

if [[ ${missing_exit} -eq 0 ]]; then
  printf "%s\n" "${missing_out}" >&2
  e2e::fail "jaiph test on nonexistent file should exit non-zero"
fi
# assert_contains: ENOENT message includes absolute path which varies per machine
e2e::assert_contains "${missing_out}" "does_not_exist.test.jh" \
  "nonexistent file is reported as error"

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
