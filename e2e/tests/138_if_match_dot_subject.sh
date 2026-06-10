#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "if_match_dot_subject"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. if + match with dot-notation subject select branches by field value ──

e2e::section "if/match dot-notation subject on typed prompt capture"

e2e::file "verdict.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow classify() {
  const r = prompt "Verdict?" returns "{ verdict: string }"
  if r.verdict == "ok" {
    log "approved"
  } else {
    log "rejected"
  }
  const label = match r.verdict {
    "ok" => "approved-arm"
    "reject" => "rejected-arm"
    _ => "unknown-arm"
  }
  return "${label}"
}
EOF

e2e::file "verdict.test.jh" <<'EOF'
import "verdict.jh" as v

test "ok verdict selects then-branch and ok arm" {
  mock prompt "{\"verdict\":\"ok\"}"
  const out = run v.classify()
  expect_equal out "approved-arm"
}

test "reject verdict selects else-branch and reject arm" {
  mock prompt "{\"verdict\":\"reject\"}"
  const out = run v.classify()
  expect_equal out "rejected-arm"
}

test "unknown verdict selects else-branch and wildcard arm" {
  mock prompt "{\"verdict\":\"maybe\"}"
  const out = run v.classify()
  expect_equal out "unknown-arm"
}
EOF

pass_out="$(jaiph test "${TEST_DIR}/verdict.test.jh" 2>&1)"

e2e::expect_stdout "${pass_out}" <<'EOF'
testing verdict.test.jh
  ▸ ok verdict selects then-branch and ok arm
  ✓ <time>
  ▸ reject verdict selects else-branch and reject arm
  ✓ <time>
  ▸ unknown verdict selects else-branch and wildcard arm
  ✓ <time>
✓ 3 test(s) passed
EOF

e2e::pass "dot-notation subjects route both if and match branches"
