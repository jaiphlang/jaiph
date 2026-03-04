#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "fail_then_retry_pass"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Scenario similar to make_ci_pass: if ! ensure rule; then run remediate; run same_workflow; fi
# Rule fails first time; remediation creates state; retry runs workflow again; rule passes.
e2e::section "if ! ensure then run remediate + run same workflow (fail first, pass on retry)"
rm -f "${TEST_DIR}/.gate_passed"

cat > "${TEST_DIR}/make_pass.jh" <<'EOF'
rule gate {
  test -f .gate_passed
}

workflow remediate {
  touch .gate_passed
}

workflow make_pass {
  if ! ensure gate; then
    run remediate
    run make_pass
  fi
}

workflow default {
  run make_pass
}
EOF

out="$(jaiph run "${TEST_DIR}/make_pass.jh" 2>&1)"
e2e::assert_file_exists "${TEST_DIR}/.gate_passed" "remediation ran (marker file created before retry)"

# Exact expected tree (time normalized to (<time>) by assert_output_equals)
expected_tree_ensure=$(printf '%s\n' \
  'running make_pass.jh' \
  'workflow default' \
  '└── workflow make_pass (<time>)' \
  '    ├── rule gate (<time> failed)' \
  '    ├── workflow remediate (<time>)' \
  '    └── workflow make_pass (<time>)' \
  '✓ PASS workflow default (<time>)')
expected_tree_ensure="${expected_tree_ensure%$'\n'}"
normalized_out="$(e2e::normalize_output "${out}")"
e2e::assert_equals "${normalized_out}" "${expected_tree_ensure}" "exact tree (ensure + remediate + make_pass)"

e2e::pass "if ! ensure with run remediate + run make_pass: fail first time, pass on retry"

# Same scenario but condition is plain bash (if ! test -f ...; then touch; run make_pass; fi).
e2e::section "if ! test (bash) then touch + run same workflow (fail first, pass on retry)"
rm -f "${TEST_DIR}/.gate_passed"

cat > "${TEST_DIR}/make_pass_bash.jh" <<'EOF'
workflow make_pass {
  if ! test -f .gate_passed; then
    touch .gate_passed
    run make_pass
  fi
}

workflow default {
  run make_pass
}
EOF

out_bash="$(jaiph run "${TEST_DIR}/make_pass_bash.jh" 2>&1)"
e2e::assert_file_exists "${TEST_DIR}/.gate_passed" "bash then-branch ran (marker created before retry)"

# Exact expected tree (time normalized to (<time>) by assert_output_equals)
expected_tree_bash=$(printf '%s\n' \
  'running make_pass_bash.jh' \
  'workflow default' \
  '└── workflow make_pass (<time>)' \
  '    └── workflow make_pass (<time>)' \
  '✓ PASS workflow default (<time>)')
expected_tree_bash="${expected_tree_bash%$'\n'}"
normalized_bash="$(e2e::normalize_output "${out_bash}")"
e2e::assert_equals "${normalized_bash}" "${expected_tree_bash}" "exact tree (bash condition + run make_pass)"

e2e::pass "if ! test with touch + run make_pass: fail first time, pass on retry"
