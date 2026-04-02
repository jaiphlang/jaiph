#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "if_else_chains"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. if not ensure with else branch ────────────────────────────────────────

e2e::section "if not ensure: rule passes → else branch taken"

e2e::file "not_ensure_else.jh" <<'EOF'
script ok_impl = `true`
rule ok_rule() {
  run ok_impl()
}

script else_action = `echo "else-ran" > else_ran.txt`

workflow default() {
  if not ensure ok_rule() {
    log "then-branch"
  } else {
    run else_action()
  }
}
EOF

rm -f "${TEST_DIR}/else_ran.txt"
else_out="$(e2e::run "not_ensure_else.jh")"

e2e::assert_file_exists "${TEST_DIR}/else_ran.txt" "else branch ran when ensure passes"

e2e::expect_stdout "${else_out}" <<'EOF'

Jaiph: Running not_ensure_else.jh

workflow default
  ▸ rule ok_rule
  ·   ▸ script ok_impl
  ·   ✓ script ok_impl (<time>)
  ✓ rule ok_rule (<time>)
  ▸ script else_action
  ✓ script else_action (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "if not ensure with else: ensure passes → else branch"

# ── 2. if not ensure: rule fails → then branch taken ─────────────────────────

e2e::section "if not ensure: rule fails → then branch taken"

e2e::file "not_ensure_then.jh" <<'EOF'
script fail_impl = `false`
rule fail_rule() {
  run fail_impl()
}

script then_action = `echo "then-ran" > then_ran.txt`

workflow default() {
  if not ensure fail_rule() {
    run then_action()
  } else {
    log "else-branch"
  }
}
EOF

rm -f "${TEST_DIR}/then_ran.txt"
then_out="$(e2e::run "not_ensure_then.jh")"

e2e::assert_file_exists "${TEST_DIR}/then_ran.txt" "then branch ran when ensure fails"

e2e::expect_stdout "${then_out}" <<'EOF'

Jaiph: Running not_ensure_then.jh

workflow default
  ▸ rule fail_rule
  ·   ▸ script fail_impl
  ·   ✗ script fail_impl (<time>)
  ✗ rule fail_rule (<time>)
  ▸ script then_action
  ✓ script then_action (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "if not ensure with else: ensure fails → then branch"

# ── 3. if ensure with else-if chain ──────────────────────────────────────────

e2e::section "if ensure with else-if chain: first fails, second passes"

e2e::file "else_if_chain.jh" <<'EOF'
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
  if ensure first_check() {
    log "first-branch"
  }
  else if ensure second_check() {
    run second_action()
  }
  else {
    log "else-branch"
  }
}
EOF

rm -f "${TEST_DIR}/second_ran.txt"
chain_out="$(e2e::run "else_if_chain.jh")"

e2e::assert_file_exists "${TEST_DIR}/second_ran.txt" "else-if branch ran"

e2e::expect_stdout "${chain_out}" <<'EOF'

Jaiph: Running else_if_chain.jh

workflow default
  ▸ rule first_check
  ·   ▸ script fail_impl
  ·   ✗ script fail_impl (<time>)
  ✗ rule first_check (<time>)
  ▸ rule second_check
  ·   ▸ script ok_impl
  ·   ✓ script ok_impl (<time>)
  ✓ rule second_check (<time>)
  ▸ script second_action
  ✓ script second_action (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "if ensure with else-if chain"
