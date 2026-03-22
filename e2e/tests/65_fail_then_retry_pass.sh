#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "fail_then_retry_pass"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Scenario with two recursive gates:
# - first call fails gate1 -> remediate1 -> recurse
# - second call fails gate2 -> remediate2 -> recurse
# Tree should reflect nested recursion depth.
e2e::section "if ! ensure supports multi-gate recursive nesting"
rm -f "${TEST_DIR}/.gate1_passed" "${TEST_DIR}/.gate2_passed"

# Given
e2e::file "make_pass.jh" <<'EOF'
rule gate1 {
  test -f .gate1_passed
}

rule gate2 {
  test -f .gate2_passed
}

workflow remediate1 {
  touch .gate1_passed
}

workflow remediate2 {
  touch .gate2_passed
}

workflow make_pass {
  if ! ensure gate1; then
    run remediate1
    run make_pass
  fi
  if ! ensure gate2; then
    run remediate2
    run make_pass
  fi
}

workflow default {
  run make_pass
}
EOF

# When
out="$(e2e::run "make_pass.jh" 2>&1)"

# Then
e2e::assert_file_exists "${TEST_DIR}/.gate1_passed" "first remediation ran (gate1 marker created)"
e2e::assert_file_exists "${TEST_DIR}/.gate2_passed" "second remediation ran (gate2 marker created)"

e2e::expect_stdout "${out}" <<'EOF'

Jaiph: Running make_pass.jh

workflow default
  ▸ workflow make_pass
  ·   ▸ rule gate1
  ·   ✗ rule gate1 (<time>)
  ·   ▸ workflow remediate1
  ·   ✓ workflow remediate1 (<time>)
  ·   ▸ workflow make_pass
  ·   ·   ▸ rule gate1
  ·   ·   ✓ rule gate1 (<time>)
  ·   ·   ▸ rule gate2
  ·   ·   ✗ rule gate2 (<time>)
  ·   ·   ▸ workflow remediate2
  ·   ·   ✓ workflow remediate2 (<time>)
  ·   ·   ▸ workflow make_pass
  ·   ·   ·   ▸ rule gate1
  ·   ·   ·   ✓ rule gate1 (<time>)
  ·   ·   ·   ▸ rule gate2
  ·   ·   ·   ✓ rule gate2 (<time>)
  ·   ·   ✓ workflow make_pass (<time>)
  ·   ✓ workflow make_pass (<time>)
  ·   ▸ rule gate2
  ·   ✓ rule gate2 (<time>)
  ✓ workflow make_pass (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "if ! ensure with two recursive gates: fail gate1 then gate2, pass on nested retries"
e2e::expect_out_files "make_pass.jh" 0

# Same scenario but condition is plain bash (if ! test -f ...; then touch; run make_pass; fi).
e2e::section "if ! test (bash) then touch + run same workflow (fail first, pass on retry)"
rm -f "${TEST_DIR}/.gate_passed"

# Given
e2e::file "make_pass_bash.jh" <<'EOF'
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

# When
out_bash="$(e2e::run "make_pass_bash.jh" 2>&1)"

# Then
e2e::assert_file_exists "${TEST_DIR}/.gate_passed" "bash then-branch ran (marker created before retry)"

e2e::expect_stdout "${out_bash}" <<'EOF'

Jaiph: Running make_pass_bash.jh

workflow default
  ▸ workflow make_pass
  ·   ▸ workflow make_pass
  ·   ✓ workflow make_pass (<time>)
  ✓ workflow make_pass (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "make_pass_bash.jh" 0

e2e::pass "if ! test with touch + run make_pass: fail first time, pass on retry"
