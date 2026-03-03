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

# Then
e2e::assert_contains "${recovery_out}" "PASS workflow default" "if ! ensure can trigger run <workflow>"
e2e::assert_file_exists "${TEST_DIR}/recovery_ran.txt" "recovery workflow ran after ensure failure"

e2e::assert_contains "${shell_out}" "PASS workflow default" "if ! ensure can trigger shell fallback"
e2e::assert_file_exists "${TEST_DIR}/shell_ran.txt" "shell fallback ran after ensure failure"

e2e::assert_contains "${skip_out}" "PASS workflow default" "if ! ensure pass path still succeeds"
if [[ -f "${TEST_DIR}/should_not_run.txt" ]]; then
  e2e::fail "if ! ensure should not execute then-branch when ensure passes"
fi
e2e::pass "if ! ensure skips then-branch when ensure passes"
