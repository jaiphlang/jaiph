#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "run_recover_loop"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# === Scenario: recover repairs then retries successfully ===
e2e::section "recover loop: fail first, repair, pass on retry"
rm -f "${TEST_DIR}/.gate_passed"

e2e::file "recover_repair.jh" <<'EOF'
script check_gate = `test -f .gate_passed`
workflow check() {
  run check_gate()
}

script do_fix = `touch .gate_passed`
workflow fix() {
  run do_fix()
}

workflow default() {
  run check() recover(err) {
    run fix()
  }
}
EOF

out="$(e2e::run "recover_repair.jh" 2>&1)"

e2e::assert_file_exists "${TEST_DIR}/.gate_passed" "recover body ran (marker created)"
e2e::expect_stdout "${out}" <<'EOF'

Jaiph: Running recover_repair.jh

workflow default
  ▸ workflow check
  ·   ▸ script check_gate
  ·   ✗ script check_gate (<time>)
  ✗ workflow check (<time>)
  ▸ workflow fix
  ·   ▸ script do_fix
  ·   ✓ script do_fix (<time>)
  ✓ workflow fix (<time>)
  ▸ workflow check
  ·   ▸ script check_gate
  ·   ✓ script check_gate (<time>)
  ✓ workflow check (<time>)
✓ PASS workflow default (<time>)
EOF
e2e::pass "recover loop: repair and retry succeeded"

# === Scenario: recover with retry limit exhaustion ===
e2e::section "recover loop: retry limit exhaustion"

e2e::file "recover_exhaust.jh" <<'EOF'
config {
  run.recover_limit = 2
}

script always_fail = `exit 1`
workflow failing() {
  run always_fail()
}

workflow default() {
  run failing() recover(err) {
    log "repair attempt"
  }
}
EOF

if out_exhaust="$(e2e::run "recover_exhaust.jh" 2>&1)"; then
  e2e::fail "should have failed after retry limit"
fi

# nondeterministic timing in nested retry output
e2e::assert_contains "${out_exhaust}" "FAIL" "workflow fails after retry limit exhaustion"

# === Scenario: recover succeeds on first attempt (no loop) ===
e2e::section "recover loop: success on first attempt skips body"

e2e::file "recover_pass.jh" <<'EOF'
script ok_impl = `echo ok`
workflow ok() {
  run ok_impl()
}

workflow default() {
  run ok() recover(err) {
    log "should not appear"
  }
}
EOF

out_pass="$(e2e::run "recover_pass.jh" 2>&1)"
e2e::expect_stdout "${out_pass}" <<'EOF'

Jaiph: Running recover_pass.jh

workflow default
  ▸ workflow ok
  ·   ▸ script ok_impl
  ·   ✓ script ok_impl (<time>)
  ✓ workflow ok (<time>)
✓ PASS workflow default (<time>)
EOF
e2e::pass "recover: success on first attempt, body never runs"
