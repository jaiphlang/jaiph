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
e2e::section "run catch supports multi-gate recursive nesting"
rm -f "${TEST_DIR}/.gate1_passed" "${TEST_DIR}/.gate2_passed"

# Given
e2e::file "make_pass.jh" <<'EOF'
script gate1_impl = `test -f .gate1_passed`
def gate1() {
  run gate1_impl()
}

script gate2_impl = `test -f .gate2_passed`
def gate2() {
  run gate2_impl()
}

script remediate1_impl = `touch .gate1_passed`
def remediate1() {
  run remediate1_impl()
}

script remediate2_impl = `touch .gate2_passed`
def remediate2() {
  run remediate2_impl()
}

def make_pass() {
  run gate1() catch (err) {
    run remediate1()
    run make_pass()
    return
  }
  run gate2() catch (err) {
    run remediate2()
    run make_pass()
    return
  }
}

export def main() {
  run make_pass()
}
EOF

# When
out="$(e2e::run "make_pass.jh" 2>&1)"

# Then
e2e::assert_file_exists "${TEST_DIR}/.gate1_passed" "first remediation ran (gate1 marker created)"
e2e::assert_file_exists "${TEST_DIR}/.gate2_passed" "second remediation ran (gate2 marker created)"
e2e::expect_stdout "${out}" <<'EOF'

Jaiph: Running make_pass.jh

def main
  ▸ def make_pass
  ·   ▸ def gate1
  ·   ·   ▸ script gate1_impl
  ·   ·   ✗ script gate1_impl (<time>)
  ·   ✗ def gate1 (<time>)
  ·   ▸ def remediate1
  ·   ·   ▸ script remediate1_impl
  ·   ·   ✓ script remediate1_impl (<time>)
  ·   ✓ def remediate1 (<time>)
  ·   ▸ def make_pass
  ·   ·   ▸ def gate1
  ·   ·   ·   ▸ script gate1_impl
  ·   ·   ·   ✓ script gate1_impl (<time>)
  ·   ·   ✓ def gate1 (<time>)
  ·   ·   ▸ def gate2
  ·   ·   ·   ▸ script gate2_impl
  ·   ·   ·   ✗ script gate2_impl (<time>)
  ·   ·   ✗ def gate2 (<time>)
  ·   ·   ▸ def remediate2
  ·   ·   ·   ▸ script remediate2_impl
  ·   ·   ·   ✓ script remediate2_impl (<time>)
  ·   ·   ✓ def remediate2 (<time>)
  ·   ·   ▸ def make_pass
  ·   ·   ·   ▸ def gate1
  ·   ·   ·   ·   ▸ script gate1_impl
  ·   ·   ·   ·   ✓ script gate1_impl (<time>)
  ·   ·   ·   ✓ def gate1 (<time>)
  ·   ·   ·   ▸ def gate2
  ·   ·   ·   ·   ▸ script gate2_impl
  ·   ·   ·   ·   ✓ script gate2_impl (<time>)
  ·   ·   ·   ✓ def gate2 (<time>)
  ·   ·   ✓ def make_pass (<time>)
  ·   ✓ def make_pass (<time>)
  ✓ def make_pass (<time>)
✓ PASS def main (<time>)
EOF

e2e::pass "run catch with two recursive gates: fail gate1 then gate2, pass on nested retries"

# Same scenario but with a single run gate.
e2e::section "single-gate recursive retry: fail first, pass on retry"
rm -f "${TEST_DIR}/.gate_passed"

# Given
e2e::file "make_pass_bash.jh" <<'EOF'
def gate() {
  run check_gate()
}
script check_gate = `test -f .gate_passed`
script mark_gate = `touch .gate_passed`
def make_pass() {
  run gate() catch (err) {
    run mark_gate()
    run make_pass()
    return
  }
}

export def main() {
  run make_pass()
}
EOF

# When
out_bash="$(e2e::run "make_pass_bash.jh" 2>&1)"

# Then
e2e::assert_file_exists "${TEST_DIR}/.gate_passed" "retry branch ran (marker created before retry)"
e2e::expect_stdout "${out_bash}" <<'EOF'

Jaiph: Running make_pass_bash.jh

def main
  ▸ def make_pass
  ·   ▸ def gate
  ·   ·   ▸ script check_gate
  ·   ·   ✗ script check_gate (<time>)
  ·   ✗ def gate (<time>)
  ·   ▸ script mark_gate
  ·   ✓ script mark_gate (<time>)
  ·   ▸ def make_pass
  ·   ·   ▸ def gate
  ·   ·   ·   ▸ script check_gate
  ·   ·   ·   ✓ script check_gate (<time>)
  ·   ·   ✓ def gate (<time>)
  ·   ✓ def make_pass (<time>)
  ✓ def make_pass (<time>)
✓ PASS def main (<time>)
EOF
e2e::pass "single-gate retry flow: fail first time, pass on retry"
