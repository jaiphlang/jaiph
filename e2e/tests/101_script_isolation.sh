#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "script_isolation"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "script cannot access parent scope variables"
# ---------------------------------------------------------------------------

e2e::file "isolation.jh" <<'EOF'
const secret = "parent-secret-value"

script leak_check = ```
echo "secret=${secret:-EMPTY}"
```

workflow default() {
  run leak_check()
}
EOF

rm -rf "${TEST_DIR}/runs_iso"
JAIPH_RUNS_DIR="runs_iso" e2e::run "isolation.jh" >/dev/null

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_iso" "isolation.jh")"
shopt -s nullglob
leak_files=( "${run_dir}"*leak_check.out )
shopt -u nullglob
[[ ${#leak_files[@]} -ge 1 ]] || e2e::fail "expected leak_check .out artifact"
leak_out="$(<"${leak_files[0]}")"
e2e::assert_equals "${leak_out}" "secret=EMPTY" "script cannot read parent const (gets empty)"

e2e::pass "script isolation: parent variables not inherited"

# ---------------------------------------------------------------------------
e2e::section "opaque script body: embedded JS line starting with const"
# ---------------------------------------------------------------------------

e2e::file "node_const.jh" <<'EOF'
script use_node = ```
node -e "
const fs = require('fs');
process.stdout.write('node-ok');
"
```

workflow default() {
  run use_node()
}
EOF

rm -rf "${TEST_DIR}/runs_nodeconst"
JAIPH_RUNS_DIR="runs_nodeconst" e2e::run "node_const.jh" >/dev/null

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_nodeconst" "node_const.jh")"
shopt -s nullglob
nc_files=( "${run_dir}"*use_node.out )
shopt -u nullglob
[[ ${#nc_files[@]} -ge 1 ]] || e2e::fail "expected use_node .out artifact"
nc_out="$(<"${nc_files[0]}")"
e2e::assert_equals "${nc_out}" "node-ok" "multiline node -e with const line runs"

e2e::pass "opaque script allows embedded const in node -e"
