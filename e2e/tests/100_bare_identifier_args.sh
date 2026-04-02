#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "bare_identifier_args"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "run script with bare identifier arg (const)"

e2e::file "bare_const.jh" <<'EOF'
script greet = `echo "hello $1"`

workflow default() {
  const name = "world"
  run greet(name)
}
EOF

rm -rf "${TEST_DIR}/runs_bare"
out="$(JAIPH_RUNS_DIR="runs_bare" e2e::run "bare_const.jh" 2>&1)"
e2e::pass "run script with bare identifier const arg compiles and runs"

e2e::section "ensure rule with bare identifier arg"

e2e::file "bare_ensure.jh" <<'EOF'
script check_impl = `true`

rule check(value) {
  run check_impl($1)
}

workflow default() {
  const status = "ok"
  ensure check(status)
}
EOF

out="$(JAIPH_RUNS_DIR="runs_bare" e2e::run "bare_ensure.jh" 2>&1)"
e2e::pass "ensure rule with bare identifier arg"

e2e::section "mixed bare and quoted args"

e2e::file "bare_mixed.jh" <<'EOF'
script combine = `echo "$1 $2"`

workflow default() {
  const tag = "v1"
  run combine(tag, "release")
}
EOF

out="$(JAIPH_RUNS_DIR="runs_bare" e2e::run "bare_mixed.jh" 2>&1)"
e2e::pass "mixed bare and quoted args"

e2e::section "unknown bare identifier fails validation"

e2e::file "bare_unknown.jh" <<'EOF'
script greet = `echo "hello $1"`

workflow default() {
  run greet(unknown_var)
}
EOF

if JAIPH_RUNS_DIR="runs_bare" e2e::run "bare_unknown.jh" >/dev/null 2>&1; then
  e2e::fail "expected validation error for unknown bare identifier"
fi
e2e::pass "unknown bare identifier rejected at compile time"
