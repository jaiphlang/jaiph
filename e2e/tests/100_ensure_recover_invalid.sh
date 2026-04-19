#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover_invalid"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "run catch with args after catch fails at parse time"

# Given
e2e::file "args_after_recover.jh" <<'EOF'
workflow ci_passes() {
  true
}

workflow default() {
  run ci_passes() catch "$repo_dir" {
    echo "should not parse"
  }
}
EOF

# When
err_file="$(mktemp)"
if jaiph run "${TEST_DIR}/args_after_recover.jh" 2>"${err_file}"; then
  cat "${err_file}" >&2
  rm -f "${err_file}"
  e2e::fail "jaiph run should fail for args after recover"
fi
err_out="$(cat "${err_file}")"
rm -f "${err_file}"

# Then
# assert_contains: compile error includes absolute source path which varies per machine
e2e::assert_contains "${err_out}" "E_PARSE" "args after catch emits E_PARSE"
# assert_contains: compile error includes absolute source path which varies per machine
e2e::assert_contains "${err_out}" "catch requires explicit bindings" "args after catch has clear error message"
e2e::pass "run catch with args after catch fails with clear error"

e2e::section "run catch with multiple args after catch fails at parse time"

# Given
e2e::file "multi_args_after_recover.jh" <<'EOF'
workflow some_rule(input) {
  true
}

workflow default() {
  run some_rule("a") catch "b" {
    echo "should not parse"
  }
}
EOF

# When
err_file="$(mktemp)"
if jaiph run "${TEST_DIR}/multi_args_after_recover.jh" 2>"${err_file}"; then
  cat "${err_file}" >&2
  rm -f "${err_file}"
  e2e::fail "jaiph run should fail for multiple args after recover"
fi
err_out="$(cat "${err_file}")"
rm -f "${err_file}"

# Then
# assert_contains: compile error includes absolute source path which varies per machine
e2e::assert_contains "${err_out}" "E_PARSE" "multiple args after catch emits E_PARSE"
# assert_contains: compile error includes absolute source path which varies per machine
e2e::assert_contains "${err_out}" "catch requires explicit bindings" "multiple args after catch has clear error message"
e2e::pass "run catch with multiple args after catch fails with clear error"

e2e::section "run catch without block fails at parse time"

# Given
e2e::file "recover_no_block.jh" <<'EOF'
workflow ci_passes(repo_dir) {
  true
}

workflow default() {
  run ci_passes("$repo_dir") catch
}
EOF

# When
err_file="$(mktemp)"
if jaiph run "${TEST_DIR}/recover_no_block.jh" 2>"${err_file}"; then
  cat "${err_file}" >&2
  rm -f "${err_file}"
  e2e::fail "jaiph run should fail for catch without block"
fi
err_out="$(cat "${err_file}")"
rm -f "${err_file}"

# Then
# assert_contains: compile error includes absolute source path which varies per machine
e2e::assert_contains "${err_out}" "E_PARSE" "catch without block emits E_PARSE"
# assert_contains: compile error includes absolute source path which varies per machine
e2e::assert_contains "${err_out}" "unexpected content after run call" "catch without block has clear error message"
e2e::pass "run catch without block fails with clear error"
