#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "match_alternation"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# CLI dispatch style: "" and "check" share one arm via alternation, "wait" hits
# another arm, and any other subject falls through to the wildcard.

e2e::file "match_dispatch.jh" <<'EOF'
script foo = `echo "ran-foo"`
script bar = `echo "ran-bar"`

workflow default(cmd) {
  const result = match cmd {
    "" | "check" => run foo()
    "wait" => run bar()
    _ => fail "bad"
  }
  log result
}
EOF

# ── 0. compile accepts alternation ───────────────────────────────────────────

e2e::section "match alternation compiles"

jaiph compile "${TEST_DIR}/match_dispatch.jh"
e2e::pass "match alternation compiles"

# ── 1. subject "check" hits the alternation arm ──────────────────────────────

e2e::section "alternation arm matches \"check\""

check_out="$(e2e::run "match_dispatch.jh" "check")"

e2e::expect_stdout "${check_out}" <<'EOF'

Jaiph: Running match_dispatch.jh

workflow default (cmd="check")
  ▸ script foo
  ✓ script foo (<time>)
  ℹ ran-foo

✓ PASS workflow default (<time>)
EOF

e2e::pass "alternation arm matches \"check\""

# ── 2. subject "" hits the SAME alternation arm ──────────────────────────────

e2e::section "alternation arm matches empty subject identically"

empty_out="$(e2e::run "match_dispatch.jh" "")"

e2e::expect_stdout "${empty_out}" <<'EOF'

Jaiph: Running match_dispatch.jh

workflow default
  ▸ script foo
  ✓ script foo (<time>)
  ℹ ran-foo

✓ PASS workflow default (<time>)
EOF

e2e::pass "empty subject hits same arm as \"check\" (ran-foo)"

# ── 3. a different subject hits another arm ──────────────────────────────────

e2e::section "different subject hits another arm"

wait_out="$(e2e::run "match_dispatch.jh" "wait")"

e2e::expect_stdout "${wait_out}" <<'EOF'

Jaiph: Running match_dispatch.jh

workflow default (cmd="wait")
  ▸ script bar
  ✓ script bar (<time>)
  ℹ ran-bar

✓ PASS workflow default (<time>)
EOF

e2e::pass "\"wait\" hits its own arm (ran-bar)"
