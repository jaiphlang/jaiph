#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "if_else_branch"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. if/else in workflow: then branch runs, else skipped ──────────────────

e2e::section "if/else workflow: then branch runs when condition true"

e2e::file "if_else_wf.jh" <<'EOF'
workflow default(status) {
  if status == "ok" {
    log "healthy"
  } else {
    log "unhealthy: ${status}"
  }
  log "done"
}
EOF

then_out="$(e2e::run "if_else_wf.jh" "ok")"
e2e::expect_stdout "${then_out}" <<'EOF'

Jaiph: Running if_else_wf.jh

workflow default (status="ok")
  ℹ healthy
  ℹ done

✓ PASS workflow default (<time>)
EOF
e2e::pass "if/else workflow: only then-branch runs when condition is true"

# ── 2. if/else in workflow: else branch runs ────────────────────────────────

e2e::section "if/else workflow: else branch runs when condition false"

else_out="$(e2e::run "if_else_wf.jh" "bad")"
e2e::expect_stdout "${else_out}" <<'EOF'

Jaiph: Running if_else_wf.jh

workflow default (status="bad")
  ℹ unhealthy: bad
  ℹ done

✓ PASS workflow default (<time>)
EOF
e2e::pass "if/else workflow: only else-branch runs when condition is false"

# ── 3. if/else in rule: both branches reachable ─────────────────────────────

e2e::section "if/else rule: then branch runs when condition true"

e2e::file "if_else_rule.jh" <<'EOF'
rule check(value) {
  if value == "" {
    fail "value was empty"
  } else {
    log "value: ${value}"
  }
}

workflow default(value) {
  ensure check(value)
  log "validated"
}
EOF

rule_ok_out="$(e2e::run "if_else_rule.jh" "hello")"
e2e::expect_stdout "${rule_ok_out}" <<'EOF'

Jaiph: Running if_else_rule.jh

workflow default (value="hello")
  ▸ rule check (value="hello")
  ·   ℹ value: hello
  ✓ rule check (<time>)
  ℹ validated

✓ PASS workflow default (<time>)
EOF
e2e::pass "if/else rule: else branch runs and rule passes when value non-empty"

# ── 4. if/else in rule: then branch fails ───────────────────────────────────

e2e::section "if/else rule: then branch fails workflow when condition true"

e2e::expect_fail "if_else_rule.jh"
e2e::pass "if/else rule: then branch fails when value empty"
