#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "cli_error_guards"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. jaiph run with no arguments ──────────────────────────────────────────

e2e::section "jaiph run with no arguments"

run_no_args_err="$(mktemp)"
if jaiph run 2>"${run_no_args_err}"; then
  rm -f "${run_no_args_err}"
  e2e::fail "jaiph run should fail when no arguments given"
fi
run_no_args_msg="$(cat "${run_no_args_err}")"
rm -f "${run_no_args_err}"

e2e::assert_contains "${run_no_args_msg}" "requires a .jh file" "run with no args reports missing file"

# ── 2. jaiph run with non-existent file ─────────────────────────────────────

e2e::section "jaiph run with non-existent file"

run_missing_err="$(mktemp)"
if jaiph run "${TEST_DIR}/does_not_exist.jh" 2>"${run_missing_err}"; then
  rm -f "${run_missing_err}"
  e2e::fail "jaiph run should fail on non-existent file"
fi
run_missing_msg="$(cat "${run_missing_err}")"
rm -f "${run_missing_err}"

# assert_contains: error message includes absolute path which varies per machine
e2e::assert_contains "${run_missing_msg}" "no such file or directory" "run with missing file reports ENOENT"

# ── 3. jaiph compile with non-existent file ─────────────────────────────────

e2e::section "jaiph compile with non-existent file"

compile_missing_err="$(mktemp)"
if jaiph compile "${TEST_DIR}/does_not_exist.jh" 2>"${compile_missing_err}"; then
  rm -f "${compile_missing_err}"
  e2e::fail "jaiph compile should fail on non-existent file"
fi
compile_missing_msg="$(cat "${compile_missing_err}")"
rm -f "${compile_missing_err}"

# assert_contains: error message includes absolute path which varies per machine
e2e::assert_contains "${compile_missing_msg}" "no such file or directory" "compile with missing file reports error"

# ── 4. jaiph test on a regular .jh file ─────────────────────────────────────

e2e::section "jaiph test on a regular .jh file"

e2e::file "not_a_test.jh" <<'EOF'
workflow default() {
  log "hello"
}
EOF

test_jh_err="$(mktemp)"
if jaiph test "${TEST_DIR}/not_a_test.jh" 2>"${test_jh_err}"; then
  rm -f "${test_jh_err}"
  e2e::fail "jaiph test should reject non-.test.jh files"
fi
test_jh_msg="$(cat "${test_jh_err}")"
rm -f "${test_jh_err}"

# assert_contains: error message includes guidance text about test file format
e2e::assert_contains "${test_jh_msg}" "test.jh" "jaiph test on .jh file shows guidance"

# ── 5. jaiph compile with arity mismatch ────────────────────────────────────

e2e::section "jaiph compile catches arity mismatch"

e2e::file "arity_bad.jh" <<'EOF'
workflow helper(a, b) {
  log "ok"
}
workflow default() {
  run helper("one")
}
EOF

arity_exit=0
jaiph compile "${TEST_DIR}/arity_bad.jh" 2>/dev/null || arity_exit=$?
e2e::assert_equals "${arity_exit}" "1" "compile exits 1 on arity mismatch"

arity_err="$(jaiph compile "${TEST_DIR}/arity_bad.jh" 2>&1 || true)"
# assert_contains: error message includes dynamic line number and file path
e2e::assert_contains "${arity_err}" "expects 2 argument(s)" "compile reports arity mismatch"
