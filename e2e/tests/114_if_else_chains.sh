#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "recover_chains"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. ensure recover: rule fails → recover runs ────────────────────────────

e2e::section "ensure recover: rule fails → recover body runs"

e2e::file "ensure_fail_recover.jh" <<'EOF'
script fail_impl = `false`
rule fail_rule() {
  run fail_impl()
}

script then_action = `echo "then-ran" > then_ran.txt`

workflow default() {
  ensure fail_rule() recover (err) {
    run then_action()
  }
}
EOF

rm -f "${TEST_DIR}/then_ran.txt"
then_out="$(e2e::run "ensure_fail_recover.jh")"

e2e::assert_file_exists "${TEST_DIR}/then_ran.txt" "recover branch ran when ensure fails"

e2e::expect_stdout "${then_out}" <<'EOF'

Jaiph: Running ensure_fail_recover.jh

workflow default
  ▸ rule fail_rule
  ·   ▸ script fail_impl
  ·   ✗ script fail_impl (<time>)
  ✗ rule fail_rule (<time>)
  ▸ script then_action
  ✓ script then_action (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "ensure recover: ensure fails → recover body runs"

# ── 2. ensure recover: rule passes → recover skipped, continue ──────────────

e2e::section "ensure recover: rule passes → recover skipped"

e2e::file "ensure_pass_no_recover.jh" <<'EOF'
script ok_impl = `true`
rule ok_rule() {
  run ok_impl()
}

script else_action = `echo "else-ran" > else_ran.txt`

workflow default() {
  ensure ok_rule() recover (err) {
    log "should-not-run"
  }
  run else_action()
}
EOF

rm -f "${TEST_DIR}/else_ran.txt"
else_out="$(e2e::run "ensure_pass_no_recover.jh")"

e2e::assert_file_exists "${TEST_DIR}/else_ran.txt" "continuation ran when ensure passes"

e2e::expect_stdout "${else_out}" <<'EOF'

Jaiph: Running ensure_pass_no_recover.jh

workflow default
  ▸ rule ok_rule
  ·   ▸ script ok_impl
  ·   ✓ script ok_impl (<time>)
  ✓ rule ok_rule (<time>)
  ▸ script else_action
  ✓ script else_action (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "ensure recover: ensure passes → recover skipped"

# ── 3. chained ensure recover: first fails, second passes ───────────────────

e2e::section "chained ensure recover: first fails, second passes"

e2e::file "chained_recover.jh" <<'EOF'
script fail_impl = `false`
rule first_check() {
  run fail_impl()
}

script ok_impl = `true`
rule second_check() {
  run ok_impl()
}

script second_action = `echo "second-ran" > second_ran.txt`

workflow default() {
  ensure first_check() recover (err) {
    log "first-recovered"
  }
  ensure second_check() recover (err) {
    log "should-not-run"
  }
  run second_action()
}
EOF

rm -f "${TEST_DIR}/second_ran.txt"
chain_out="$(e2e::run "chained_recover.jh")"

e2e::assert_file_exists "${TEST_DIR}/second_ran.txt" "continuation after chained recovers ran"

e2e::expect_stdout "${chain_out}" <<'EOF'

Jaiph: Running chained_recover.jh

workflow default
  ▸ rule first_check
  ·   ▸ script fail_impl
  ·   ✗ script fail_impl (<time>)
  ✗ rule first_check (<time>)
  ℹ first-recovered
  ▸ rule second_check
  ·   ▸ script ok_impl
  ·   ✓ script ok_impl (<time>)
  ✓ rule second_check (<time>)
  ▸ script second_action
  ✓ script second_action (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "chained ensure recover: first fails, second passes"
