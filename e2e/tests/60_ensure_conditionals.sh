#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_conditionals"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "if ! ensure branch behavior"
# Given
cat > "${TEST_DIR}/ensure_run_branch.jh" <<'EOF'
rule always_ok {
  true
}

rule always_fail {
  false
}

workflow recovery {
  echo "recovery-ran" > recovery_ran.txt
}

workflow default {
  if ! ensure always_fail; then
    run recovery
  fi
}
EOF

cat > "${TEST_DIR}/ensure_shell_branch.jh" <<'EOF'
rule always_fail {
  false
}

workflow default {
  if ! ensure always_fail; then
    echo "shell-ran" > shell_ran.txt
  fi
}
EOF

cat > "${TEST_DIR}/ensure_pass_branch.jh" <<'EOF'
rule always_ok {
  true
}

workflow default {
  if ! ensure always_ok; then
    echo "should-not-run" > should_not_run.txt
  fi
}
EOF

# When
rm -f "${TEST_DIR}/recovery_ran.txt" "${TEST_DIR}/shell_ran.txt" "${TEST_DIR}/should_not_run.txt"
recovery_out="$(jaiph run "${TEST_DIR}/ensure_run_branch.jh")"
shell_out="$(jaiph run "${TEST_DIR}/ensure_shell_branch.jh")"
skip_out="$(jaiph run "${TEST_DIR}/ensure_pass_branch.jh")"

# Then: exact trees for each branch variant
e2e::assert_file_exists "${TEST_DIR}/recovery_ran.txt" "recovery workflow ran after ensure failure"

expected_recovery=$(printf '%s\n' \
  '' \
  'running ensure_run_branch.jh' \
  '' \
  'workflow default' \
  '  ▸ rule always_fail' \
  '  ✗ <time>' \
  '  ▸ workflow recovery' \
  '  ✓ <time>' \
  '✓ PASS workflow default (<time>)')
expected_recovery="${expected_recovery%$'\n'}"
e2e::assert_output_equals "${recovery_out}" "${expected_recovery}" "if ! ensure can trigger run <workflow>"

e2e::assert_file_exists "${TEST_DIR}/shell_ran.txt" "shell fallback ran after ensure failure"

expected_shell=$(printf '%s\n' \
  '' \
  'running ensure_shell_branch.jh' \
  '' \
  'workflow default' \
  '  ▸ rule always_fail' \
  '  ✗ <time>' \
  '✓ PASS workflow default (<time>)')
expected_shell="${expected_shell%$'\n'}"
e2e::assert_output_equals "${shell_out}" "${expected_shell}" "if ! ensure can trigger shell fallback"

expected_skip=$(printf '%s\n' \
  '' \
  'running ensure_pass_branch.jh' \
  '' \
  'workflow default' \
  '  ▸ rule always_ok' \
  '  ✓ <time>' \
  '✓ PASS workflow default (<time>)')
expected_skip="${expected_skip%$'\n'}"
e2e::assert_output_equals "${skip_out}" "${expected_skip}" "if ! ensure pass path still succeeds"
if [[ -f "${TEST_DIR}/should_not_run.txt" ]]; then
  e2e::fail "if ! ensure should not execute then-branch when ensure passes"
fi
e2e::pass "if ! ensure skips then-branch when ensure passes"
if [[ -f "${TEST_DIR}/should_not_run.txt" ]]; then
  e2e::fail "if ! ensure should not execute then-branch when ensure passes"
fi
e2e::pass "if ! ensure skips then-branch when ensure passes"
