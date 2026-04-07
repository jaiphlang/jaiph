#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "double_dash_passthrough"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "double-dash passes positional args to workflow"
# ---------------------------------------------------------------------------

# Given — a workflow that echoes its positional parameter
e2e::file "greet.jh" <<'EOF'
script greet_impl = `echo "hello $1"`
workflow default(name) {
  run greet_impl(name)
}
EOF

# When — pass arg after --
greet_out="$(e2e::run "greet.jh" -- "world")"

# Then — CLI tree output
e2e::expect_stdout "${greet_out}" <<'EOF'

Jaiph: Running greet.jh

workflow default (name="world")
  ▸ script greet_impl (1="world")
  ✓ script greet_impl (<time>)

✓ PASS workflow default (<time>)
EOF

# Then — run artifacts
e2e::expect_out "greet.jh" "greet_impl" "hello world"

e2e::pass "double-dash passes positional args to workflow"
