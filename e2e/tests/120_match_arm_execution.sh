#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "match_arm_execution"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. match arm with fail aborts the workflow ─────────────────────────────

e2e::section "match arm fail aborts workflow"

e2e::file "match_fail.jh" <<'EOF'
script safe_name = `printf '%s\n' "$1" | tr '/:' '--'`

workflow default(name_param) {
  const name = match name_param {
    "" => fail "usage: provide a name"
    _ => run safe_name(name_param)
  }
  log name
}
EOF

e2e::expect_fail "match_fail.jh"
e2e::pass "match arm fail exits non-zero"

# Capture output to verify no fake log line
fail_out="$(e2e::run "match_fail.jh" 2>&1 || true)"
# nondeterministic: run dir path contains timestamp
e2e::assert_contains "${fail_out}" "FAIL workflow default" "fail output shows FAIL"

# The output must NOT contain a log line masquerading as the fail message
if echo "${fail_out}" | grep -q 'ℹ fail'; then
  e2e::fail "output should not contain fake log of fail body"
fi
e2e::pass "no fake log line for fail arm"

# ── 2. match arm with run executes the script ──────────────────────────────

e2e::section "match arm run executes script"

e2e::file "match_run.jh" <<'EOF'
script safe_name = `printf '%s\n' "$1" | tr '/:' '--'`

workflow default(name_param) {
  const name = match name_param {
    "" => fail "usage: provide a name"
    _ => run safe_name(name_param)
  }
  log name
}
EOF

run_out="$(e2e::run "match_run.jh" "some/name")"

e2e::expect_stdout "${run_out}" <<'EOF'

Jaiph: Running match_run.jh

workflow default (name_param="some/name")
  ▸ script safe_name (1="some/name")
  ✓ script safe_name (<time>)
  ℹ some-name

✓ PASS workflow default (<time>)
EOF

e2e::expect_out "match_run.jh" "safe_name" "some-name"
e2e::pass "match arm run executes script and captures value"
