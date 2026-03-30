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

script leak_check {
  echo "secret=${secret:-EMPTY}"
}

workflow default {
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
e2e::section "JAIPH_LIB defaults to workspace .jaiph/lib (Node runtime)"
# ---------------------------------------------------------------------------

e2e::file "lib_check.jh" <<'EOF'
script check_lib {
  echo "lib=${JAIPH_LIB:-UNSET}"
}

workflow default {
  run check_lib()
}
EOF

rm -rf "${TEST_DIR}/runs_lib"
JAIPH_RUNS_DIR="runs_lib" e2e::run "lib_check.jh" >/dev/null

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_lib" "lib_check.jh")"
shopt -s nullglob
lib_files=( "${run_dir}"*check_lib.out )
shopt -u nullglob
[[ ${#lib_files[@]} -ge 1 ]] || e2e::fail "expected check_lib .out artifact"
lib_out="$(<"${lib_files[0]}")"
expected_lib="$(cd "${TEST_DIR}" && pwd)/.jaiph/lib"
e2e::assert_equals "${lib_out}" "lib=${expected_lib}" "JAIPH_LIB defaults to \${JAIPH_WORKSPACE}/.jaiph/lib"

e2e::pass "JAIPH_LIB default matches workspace lib dir"

# ---------------------------------------------------------------------------
e2e::section "source \$JAIPH_LIB/... works from isolated script"
# ---------------------------------------------------------------------------

mkdir -p "${TEST_DIR}/.jaiph/lib"
cat > "${TEST_DIR}/.jaiph/lib/test_util.sh" <<'LIBEOF'
test_util_greeting() {
  printf "hello-from-lib"
}
LIBEOF

e2e::file "source_lib.jh" <<'EOF'
script use_lib {
  source "$JAIPH_LIB/test_util.sh"
  test_util_greeting
}

workflow default {
  run use_lib()
}
EOF

rm -rf "${TEST_DIR}/runs_srclib"
JAIPH_LIB="${TEST_DIR}/.jaiph/lib" JAIPH_RUNS_DIR="runs_srclib" e2e::run "source_lib.jh" >/dev/null

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_srclib" "source_lib.jh")"
shopt -s nullglob
srclib_files=( "${run_dir}"*use_lib.out )
shopt -u nullglob
[[ ${#srclib_files[@]} -ge 1 ]] || e2e::fail "expected use_lib .out artifact"
srclib_out="$(<"${srclib_files[0]}")"
e2e::assert_equals "${srclib_out}" "hello-from-lib" "source JAIPH_LIB works in isolated script"

e2e::pass "shared library sourcing works under isolation"

# ---------------------------------------------------------------------------
e2e::section "opaque script body: embedded JS line starting with const"
# ---------------------------------------------------------------------------

e2e::file "node_const.jh" <<'EOF'
script use_node {
  node -e "
const fs = require('fs');
process.stdout.write('node-ok');
"
}

workflow default {
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
