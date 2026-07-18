#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "if_else_if_chain"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# A three-arm `if / else if / else` chain must execute exactly one branch.

e2e::file "if_else_if.jh" <<'EOF'
workflow default(status) {
  if status == "ok" {
    log "healthy"
  } else if status == "warn" {
    logwarn "degraded"
  } else {
    logerr "unhealthy: ${status}"
  }
  log "done"
}
EOF

# ── 1. first arm runs, others skipped ───────────────────────────────────────

e2e::section "else if chain: first arm runs when condition true"

first_out="$(e2e::run "if_else_if.jh" "ok")"
e2e::expect_stdout "${first_out}" <<'EOF'

Jaiph: Running if_else_if.jh

workflow default (status="ok")
  ℹ healthy
  ℹ done

✓ PASS workflow default (<time>)
EOF
e2e::pass "else if chain: only the first arm runs for status=ok"

# ── 2. middle `else if` arm runs ────────────────────────────────────────────

e2e::section "else if chain: middle arm runs when its condition matches"

middle_out="$(e2e::run "if_else_if.jh" "warn")"
e2e::expect_stdout "${middle_out}" <<'EOF'

Jaiph: Running if_else_if.jh

workflow default (status="warn")
  ⚠ degraded
  ℹ done

✓ PASS workflow default (<time>)
EOF
e2e::pass "else if chain: only the middle arm runs for status=warn"

# ── 3. terminal `else` arm runs ─────────────────────────────────────────────

e2e::section "else if chain: else arm runs when no condition matches"

else_out="$(e2e::run "if_else_if.jh" "boom")"
e2e::expect_stdout "${else_out}" <<'EOF'

Jaiph: Running if_else_if.jh

workflow default (status="boom")
  ! unhealthy: boom
  ℹ done

✓ PASS workflow default (<time>)
EOF
e2e::pass "else if chain: only the else arm runs for an unmatched status"
