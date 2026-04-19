#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "recover_chains"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. run recover: workflow fails → catch runs ────────────────────────────

e2e::section "run recover: workflow fails → catch body runs"

e2e::file "ensure_fail_recover.jh" <<'EOF'
script fail_impl = `false`
workflow fail_rule() {
  run fail_impl()
}

script then_action = `echo "then-ran" > then_ran.txt`

workflow default() {
  run fail_rule() catch (err) {
    run then_action()
  }
}
EOF

rm -f "${TEST_DIR}/then_ran.txt"
then_out="$(e2e::run "ensure_fail_recover.jh")"

e2e::assert_file_exists "${TEST_DIR}/then_ran.txt" "recover branch ran when run fails"

e2e::expect_stdout "${then_out}" <<'EOF'

Jaiph: Running ensure_fail_recover.jh

workflow default
  ▸ workflow fail_rule
  ·   ▸ script fail_impl
  ·   ✗ script fail_impl (<time>)
  ✗ workflow fail_rule (<time>)
  ▸ script then_action
  ✓ script then_action (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "run recover: run fails → catch body runs"

# ── 2. run recover: workflow passes → catch skipped, continue ──────────────

e2e::section "run recover: workflow passes → catch skipped"

e2e::file "ensure_pass_no_recover.jh" <<'EOF'
script ok_impl = `true`
workflow ok_rule() {
  run ok_impl()
}

script else_action = `echo "else-ran" > else_ran.txt`

workflow default() {
  run ok_rule() catch (err) {
    log "should-not-run"
  }
  run else_action()
}
EOF

rm -f "${TEST_DIR}/else_ran.txt"
else_out="$(e2e::run "ensure_pass_no_recover.jh")"

e2e::assert_file_exists "${TEST_DIR}/else_ran.txt" "continuation ran when run passes"

e2e::expect_stdout "${else_out}" <<'EOF'

Jaiph: Running ensure_pass_no_recover.jh

workflow default
  ▸ workflow ok_rule
  ·   ▸ script ok_impl
  ·   ✓ script ok_impl (<time>)
  ✓ workflow ok_rule (<time>)
  ▸ script else_action
  ✓ script else_action (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "run recover: run passes → catch skipped"

# ── 3. chained run recover: first fails, second passes ───────────────────

e2e::section "chained run recover: first fails, second passes"

e2e::file "chained_recover.jh" <<'EOF'
script fail_impl = `false`
workflow first_check() {
  run fail_impl()
}

script ok_impl = `true`
workflow second_check() {
  run ok_impl()
}

script second_action = `echo "second-ran" > second_ran.txt`

workflow default() {
  run first_check() catch (err) {
    log "first-recovered"
  }
  run second_check() catch (err) {
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
  ▸ workflow first_check
  ·   ▸ script fail_impl
  ·   ✗ script fail_impl (<time>)
  ✗ workflow first_check (<time>)
  ℹ first-recovered
  ▸ workflow second_check
  ·   ▸ script ok_impl
  ·   ✓ script ok_impl (<time>)
  ✓ workflow second_check (<time>)
  ▸ script second_action
  ✓ script second_action (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "chained run recover: first fails, second passes"
