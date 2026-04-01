#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover_value"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ===================================================================
e2e::section "ensure...recover: assignment returns the last successful rule return value"
# ===================================================================

e2e::file "recover_capture.jh" <<'EOF'
script check_ready_impl = ```
echo "rule-stdout-check"
test -f ready.txt
```
rule check_ready() {
  run check_ready_impl()
  return "ready-value"
}

script fix_it_impl = "touch ready.txt"
workflow fix_it() {
  run fix_it_impl()
}

script echo_captured = "echo \"captured=$1\""
workflow default() {
  val = ensure check_ready() recover run fix_it()
  run echo_captured(val)
}
EOF
rm -f "${TEST_DIR}/ready.txt"
rm -rf "${TEST_DIR}/runs_rcap"

JAIPH_RUNS_DIR="runs_rcap" e2e::run "recover_capture.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_rcap" "recover_capture.jh")"

# Assignment variable gets the return value from the successful rule call
shopt -s nullglob
cap_outs=( "${run_dir}"/*echo_captured.out )
shopt -u nullglob
[[ ${#cap_outs[@]} -ge 1 ]] || e2e::fail "expected echo_captured .out artifact"
cap_content="$(<"${cap_outs[0]}")"
e2e::assert_equals "${cap_content}" "captured=ready-value" "ensure...recover capture = return value from successful rule"

# Rule stdout goes to artifacts, not into capture
if [[ "${cap_content}" == *"rule-stdout-check"* ]]; then
  e2e::fail "rule stdout must NOT leak into capture variable"
fi
e2e::pass "ensure...recover capture: return value only"

# ===================================================================
e2e::section "ensure...recover: recover block receives merged stdout+stderr from failed rule"
# ===================================================================

rm -f "${TEST_DIR}/ready2.txt"
rm -f "${TEST_DIR}/recover_received.txt"

e2e::file "recover_receives_output.jh" <<'EOF'
script analyze_impl = ```
echo "analysis-stdout-log"
test -f ready2.txt
```
rule analyze() {
  run analyze_impl()
}

script recover_handler = ```
echo "$1" > recover_received.txt
touch ready2.txt
```
workflow default() {
  ensure analyze() recover {
    run recover_handler(arg1)
  }
}
EOF
rm -rf "${TEST_DIR}/runs_rrv"

JAIPH_RUNS_DIR="runs_rrv" e2e::run "recover_receives_output.jh" >/dev/null 2>&1

# The recover block should receive the merged stdout+stderr from the failed rule
e2e::assert_file_exists "${TEST_DIR}/recover_received.txt" "recover block ran"
recover_content="$(<"${TEST_DIR}/recover_received.txt")"
# assert_contains: recover $1 contains merged stdout+stderr from failed rule; may include extra runtime text
e2e::assert_contains "${recover_content}" "analysis-stdout-log" "recover block receives rule stdout in \$1"
e2e::pass "ensure...recover: recover block output semantics"

# ===================================================================
e2e::section "ensure...recover: rule stdout goes to artifacts"
# ===================================================================

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_rrv" "recover_receives_output.jh")"

# Rule's script stdout goes to .out artifacts
shopt -s nullglob
rule_outs=( "${run_dir}"/*analyze_impl.out )
shopt -u nullglob
[[ ${#rule_outs[@]} -ge 1 ]] || e2e::fail "expected analyze_impl .out artifact"
rule_out="$(<"${rule_outs[0]}")"
e2e::assert_equals "${rule_out}" "analysis-stdout-log" "rule script stdout in .out artifact"
e2e::pass "ensure...recover: rule stdout in artifacts"
