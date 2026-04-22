#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "triple_quoted_strings"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. Triple-quoted log message ─────────────────────────────────────────────

e2e::section "Triple-quoted log message"

e2e::file "log_multiline.jh" <<'EOF'
workflow default() {
  log """
Hello
World
"""
}
EOF

log_out="$(e2e::run "log_multiline.jh")"

e2e::expect_stdout "${log_out}" <<'EOF'

Jaiph: Running log_multiline.jh

workflow default
  ℹ Hello
World

✓ PASS workflow default (<time>)
EOF

# ── 2. Triple-quoted return value ─────────────────────────────────────────────

e2e::section "Triple-quoted return value"

e2e::file "return_multiline.jh" <<'EOF'
workflow default() {
  return """
line one
line two
"""
}
EOF

return_out="$(e2e::run "return_multiline.jh")"

e2e::expect_stdout "${return_out}" <<'EOF'

Jaiph: Running return_multiline.jh

workflow default

✓ PASS workflow default (<time>)

line one
line two
EOF

# ── 3. Triple-quoted const with interpolation ─────────────────────────────────

e2e::section "Triple-quoted const with interpolation"

e2e::file "const_multiline.jh" <<'EOF'
workflow default() {
  const name = "world"
  const msg = """
Hello ${name}
Goodbye ${name}
"""
  log "${msg}"
}
EOF

const_out="$(e2e::run "const_multiline.jh")"

e2e::expect_stdout "${const_out}" <<'EOF'

Jaiph: Running const_multiline.jh

workflow default
  ℹ Hello world
Goodbye world

✓ PASS workflow default (<time>)
EOF

# ── 4. Triple-quoted fail message ─────────────────────────────────────────────

e2e::section "Triple-quoted fail message"

e2e::file "fail_multiline.jh" <<'EOF'
workflow default() {
  fail """
something
went wrong
"""
}
EOF

e2e::expect_fail "fail_multiline.jh"
e2e::pass "triple-quoted fail causes workflow failure"
