#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "match_expression"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. match with string literal arms ────────────────────────────────────────

e2e::section "match with string literal and wildcard"

e2e::file "match_string.jh" <<'EOF'
script get_status = "echo \"error\""

workflow default {
  const status = run get_status()
  return status match {
    "ok" => "all good"
    "error" => "something broke"
    _ => "unknown"
  }
}
EOF

match_out="$(e2e::run "match_string.jh")"

e2e::expect_stdout "${match_out}" <<'EOF'

Jaiph: Running match_string.jh

workflow default
  ▸ script get_status
  ✓ script get_status (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out "match_string.jh" "get_status" "error"
e2e::pass "match with string literal arm"

# ── 2. match with wildcard fallback ──────────────────────────────────────────

e2e::section "match falls through to wildcard"

e2e::file "match_wildcard.jh" <<'EOF'
script get_mode = "echo \"unknown-mode\""

workflow default {
  const mode = run get_mode()
  return mode match {
    "fast" => "speed"
    "safe" => "safety"
    _ => "default"
  }
}
EOF

wildcard_out="$(e2e::run "match_wildcard.jh")"

e2e::expect_stdout "${wildcard_out}" <<'EOF'

Jaiph: Running match_wildcard.jh

workflow default
  ▸ script get_mode
  ✓ script get_mode (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out "match_wildcard.jh" "get_mode" "unknown-mode"
e2e::pass "match wildcard arm"

# ── 3. match with regex arm ──────────────────────────────────────────────────

e2e::section "match with regex pattern"

e2e::file "match_regex.jh" <<'EOF'
script get_input = "echo \"ERROR: something failed\""

workflow default {
  const msg = run get_input()
  return msg match {
    /^ERROR/ => "error"
    /^WARN/ => "warning"
    _ => "info"
  }
}
EOF

regex_out="$(e2e::run "match_regex.jh")"

e2e::expect_stdout "${regex_out}" <<'EOF'

Jaiph: Running match_regex.jh

workflow default
  ▸ script get_input
  ✓ script get_input (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out "match_regex.jh" "get_input" "ERROR: something failed"
e2e::pass "match regex arm"

# ── 4. match in return with captured variable ────────────────────────────────

e2e::section "match in return with captured variable"

e2e::file "match_return.jh" <<'EOF'
script get_code = "echo \"200\""

workflow default {
  const code = run get_code()
  return code match {
    "200" => "success"
    "404" => "not found"
    _ => "other"
  }
}
EOF

return_out="$(e2e::run "match_return.jh")"

e2e::expect_stdout "${return_out}" <<'EOF'

Jaiph: Running match_return.jh

workflow default
  ▸ script get_code
  ✓ script get_code (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::pass "match in return statement"
