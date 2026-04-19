#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover_value"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ===================================================================
e2e::section "run capture = return value from successful workflow"
# ===================================================================

e2e::file "capture_success.jh" <<'EOF'
script check_ready_impl = ```
echo "rule-stdout-check"
```
workflow check_ready() {
  run check_ready_impl()
  return "ready-value"
}

script echo_captured = `echo "captured=$1"`
workflow default() {
  const val = run check_ready()
  run echo_captured(val)
}
EOF
rm -rf "${TEST_DIR}/runs_rcap"

JAIPH_RUNS_DIR="runs_rcap" e2e::run "capture_success.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_rcap" "capture_success.jh")"

# Assignment variable gets the return value from the successful workflow call
shopt -s nullglob
cap_outs=( "${run_dir}"/*echo_captured.out )
shopt -u nullglob
[[ ${#cap_outs[@]} -ge 1 ]] || e2e::fail "expected echo_captured .out artifact"
cap_content="$(<"${cap_outs[0]}")"
e2e::assert_equals "${cap_content}" "captured=ready-value" "run...recover capture = return value from successful workflow"

# Rule stdout goes to artifacts, not into capture
if [[ "${cap_content}" == *"rule-stdout-check"* ]]; then
  e2e::fail "workflow stdout must NOT leak into capture variable"
fi
e2e::pass "run capture: return value only"

# ===================================================================
e2e::section "run...recover: catch block receives merged stdout+stderr from failed workflow"
# ===================================================================

rm -f "${TEST_DIR}/recover_received.txt"

e2e::file "recover_receives_output.jh" <<'EOF'
script analyze_impl = ```
echo "analysis-stdout-log"
exit 1
```
workflow analyze() {
  run analyze_impl()
}

script recover_handler = `echo "$1" > recover_received.txt`
workflow default() {
  run analyze() catch (failure) {
    run recover_handler(failure)
  }
}
EOF
rm -rf "${TEST_DIR}/runs_rrv"

JAIPH_RUNS_DIR="runs_rrv" e2e::run "recover_receives_output.jh" >/dev/null 2>&1

# The catch block should receive the merged stdout+stderr from the failed workflow
e2e::assert_file_exists "${TEST_DIR}/recover_received.txt" "recover block ran"
recover_content="$(<"${TEST_DIR}/recover_received.txt")"
# assert_contains: catch $1 contains merged stdout+stderr from failed workflow; may include extra runtime text
e2e::assert_contains "${recover_content}" "analysis-stdout-log" "recover block receives workflow stdout in \$1"
e2e::pass "run...recover: catch block output semantics"

# ===================================================================
e2e::section "run...recover: workflow stdout goes to artifacts"
# ===================================================================

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_rrv" "recover_receives_output.jh")"

# Workflow's script stdout goes to .out artifacts
shopt -s nullglob
rule_outs=( "${run_dir}"/*analyze_impl.out )
shopt -u nullglob
[[ ${#rule_outs[@]} -ge 1 ]] || e2e::fail "expected analyze_impl .out artifact"
rule_out="$(<"${rule_outs[0]}")"
e2e::assert_equals "${rule_out}" "analysis-stdout-log" "workflow script stdout in .out artifact"
e2e::pass "run...recover: workflow stdout in artifacts"
