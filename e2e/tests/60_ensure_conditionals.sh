#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_conditionals"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "brace if not ensure branch behavior"

# Given
e2e::file "ensure_run_branch.jh" <<'EOF'
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
  if not ensure always_fail {
    run recovery
  }
}
EOF

e2e::file "ensure_shell_branch.jh" <<'EOF'
rule always_fail {
  false
}

workflow default {
  if not ensure always_fail {
    echo "shell-ran" > shell_ran.txt
  }
}
EOF

e2e::file "ensure_pass_branch.jh" <<'EOF'
rule always_ok {
  true
}

workflow default {
  if not ensure always_ok {
    echo "should-not-run" > should_not_run.txt
  }
}
EOF

# When
rm -f "${TEST_DIR}/recovery_ran.txt" "${TEST_DIR}/shell_ran.txt" "${TEST_DIR}/should_not_run.txt"
recovery_out="$(e2e::run "ensure_run_branch.jh")"
shell_out="$(e2e::run "ensure_shell_branch.jh")"
skip_out="$(e2e::run "ensure_pass_branch.jh")"

# Then
e2e::assert_file_exists "${TEST_DIR}/recovery_ran.txt" "recovery workflow ran after ensure failure"

e2e::expect_stdout "${recovery_out}" <<'EOF'

Jaiph: Running ensure_run_branch.jh

workflow default
  ▸ rule always_fail
  ✗ rule always_fail (<time>)
  ▸ workflow recovery
  ✓ workflow recovery (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "ensure_run_branch.jh" 0

e2e::assert_file_exists "${TEST_DIR}/shell_ran.txt" "shell fallback ran after ensure failure"

e2e::expect_stdout "${shell_out}" <<'EOF'

Jaiph: Running ensure_shell_branch.jh

workflow default
  ▸ rule always_fail
  ✗ rule always_fail (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "ensure_shell_branch.jh" 0

e2e::expect_stdout "${skip_out}" <<'EOF'

Jaiph: Running ensure_pass_branch.jh

workflow default
  ▸ rule always_ok
  ✓ rule always_ok (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "ensure_pass_branch.jh" 0

if [[ -f "${TEST_DIR}/should_not_run.txt" ]]; then
  e2e::fail "if not ensure should not execute then-branch when ensure passes"
fi
e2e::pass "if not ensure skips then-branch when ensure passes"
