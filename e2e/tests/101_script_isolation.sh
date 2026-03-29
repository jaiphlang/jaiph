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

script leak_check() {
  echo "secret=${secret:-EMPTY}"
}

workflow default {
  run leak_check
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
e2e::section "JAIPH_LIB is unset by default in isolated scripts"
# ---------------------------------------------------------------------------

e2e::file "lib_check.jh" <<'EOF'
script check_lib() {
  echo "lib=${JAIPH_LIB:-UNSET}"
}

workflow default {
  run check_lib
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
e2e::assert_equals "${lib_out}" "lib=UNSET" "JAIPH_LIB is unset unless explicitly provided"

e2e::pass "JAIPH_LIB default is unset in isolated script"

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
script use_lib() {
  source "$JAIPH_LIB/test_util.sh"
  test_util_greeting
}

workflow default {
  run use_lib
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
e2e::assert_contains "${srclib_out}" "hello-from-lib" "source JAIPH_LIB works in isolated script"

e2e::pass "shared library sourcing works under isolation"

# ---------------------------------------------------------------------------
e2e::section "cross-script call detected at compile time"
# ---------------------------------------------------------------------------

e2e::file "cross_call.jh" <<'EOF'
script helper() {
  echo "helper-ran"
}

script caller() {
  helper
}

workflow default {
  run caller
}
EOF

if jaiph run "${TEST_DIR}/cross_call.jh" >/dev/null 2>&1; then
  e2e::fail "expected run to fail on cross-script call"
fi
err_out="$(jaiph run "${TEST_DIR}/cross_call.jh" 2>&1 || true)"
e2e::assert_contains "${err_out}" "scripts cannot call other Jaiph scripts" "cross-script call error message"

e2e::pass "cross-script call rejected at compile time"
