#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover_invalid"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "ensure recover with args after recover fails at parse time"

# Given
e2e::file "args_after_recover.jh" <<'EOF'
rule ci_passes() {
  true
}

workflow default() {
  ensure ci_passes recover "$repo_dir" {
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
e2e::assert_contains "${err_out}" "E_PARSE" "args after recover emits E_PARSE"
e2e::assert_contains "${err_out}" "rule arguments must appear before 'recover'" "args after recover has clear error message"
e2e::pass "ensure recover with args after recover fails with clear error"

e2e::section "ensure recover with multiple args after recover fails at parse time"

# Given
e2e::file "multi_args_after_recover.jh" <<'EOF'
rule some_rule() {
  true
}

workflow default() {
  ensure some_rule "a" recover "b" {
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
e2e::assert_contains "${err_out}" "E_PARSE" "multiple args after recover emits E_PARSE"
e2e::assert_contains "${err_out}" "rule arguments must appear before 'recover'" "multiple args after recover has clear error message"
e2e::pass "ensure recover with multiple args after recover fails with clear error"

e2e::section "ensure recover without block fails at parse time"

# Given
e2e::file "recover_no_block.jh" <<'EOF'
rule ci_passes() {
  true
}

workflow default() {
  ensure ci_passes "$repo_dir" recover
}
EOF

# When
err_file="$(mktemp)"
if jaiph run "${TEST_DIR}/recover_no_block.jh" 2>"${err_file}"; then
  cat "${err_file}" >&2
  rm -f "${err_file}"
  e2e::fail "jaiph run should fail for recover without block"
fi
err_out="$(cat "${err_file}")"
rm -f "${err_file}"

# Then
e2e::assert_contains "${err_out}" "E_PARSE" "recover without block emits E_PARSE"
e2e::assert_contains "${err_out}" "recover requires a { ... } block" "recover without block has clear error message"
e2e::pass "ensure recover without block fails with clear error"
