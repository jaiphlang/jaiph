#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "recover_chains"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. run recover: rule fails → catch runs ────────────────────────────

e2e::section "run recover: rule fails → catch body runs"

e2e::file "ensure_fail_recover.jh" <<'EOF'
script fail_impl = `false`
def fail_rule() {
  run fail_impl()
}

script then_action = `echo "then-ran" > then_ran.txt`

export def main() {
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

export def main
  ▸ def fail_rule
  ·   ▸ script fail_impl
  ·   ✗ script fail_impl (<time>)
  ✗ def fail_rule(<time>)
  ▸ script then_action
  ✓ script then_action (<time>)
✓ PASS export def main (<time>)
EOF

e2e::pass "run recover: run fails → catch body runs"

# ── 2. run recover: rule passes → catch skipped, continue ──────────────

e2e::section "run recover: rule passes → catch skipped"

e2e::file "ensure_pass_no_recover.jh" <<'EOF'
script ok_impl = `true`
def ok_rule() {
  run ok_impl()
}

script else_action = `echo "else-ran" > else_ran.txt`

export def main() {
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

export def main
  ▸ def ok_rule
  ·   ▸ script ok_impl
  ·   ✓ script ok_impl (<time>)
  ✓ def ok_rule(<time>)
  ▸ script else_action
  ✓ script else_action (<time>)
✓ PASS export def main (<time>)
EOF

e2e::pass "run recover: run passes → catch skipped"

# ── 3. chained run recover: first fails, second passes ───────────────────

e2e::section "chained run recover: first fails, second passes"

e2e::file "chained_recover.jh" <<'EOF'
script fail_impl = `false`
def first_check() {
  run fail_impl()
}

script ok_impl = `true`
def second_check() {
  run ok_impl()
}

script second_action = `echo "second-ran" > second_ran.txt`

export def main() {
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

export def main
  ▸ def first_check
  ·   ▸ script fail_impl
  ·   ✗ script fail_impl (<time>)
  ✗ def first_check(<time>)
  ℹ first-recovered
  ▸ def second_check
  ·   ▸ script ok_impl
  ·   ✓ script ok_impl (<time>)
  ✓ def second_check(<time>)
  ▸ script second_action
  ✓ script second_action (<time>)
✓ PASS export def main (<time>)
EOF

e2e::pass "chained run recover: first fails, second passes"
