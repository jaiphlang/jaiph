#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover_value"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ===================================================================
e2e::section "run capture = return value from successful rule"
# ===================================================================

e2e::file "capture_success.jh" <<'EOF'
script check_ready_impl = ```
echo "rule-stdout-check"
```
def check_ready() {
  run check_ready_impl()
  return "ready-value"
}

script echo_captured = `echo "captured=$1"`
export def main() {
  const val = run check_ready()
  run echo_captured(val)
}
EOF
rm -rf "${TEST_DIR}/runs_rcap"

JAIPH_RUNS_DIR="runs_rcap" e2e::run "capture_success.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_rcap" "capture_success.jh")"

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
e2e::pass "run capture: return value only"

# ===================================================================
e2e::section "ensure...recover: catch block binds the failed rule's stdout capture PATH"
# ===================================================================

rm -f "${TEST_DIR}/recover_received.txt"

e2e::file "recover_receives_output.jh" <<'EOF'
script analyze_impl = ```
echo "analysis-stdout-log"
exit 1
```
def analyze() {
  run analyze_impl()
}

script recover_handler = `printf '%s' "$1" > recover_received.txt`
export def main() {
  run analyze() catch (failure) {
    run recover_handler(failure)
  }
}
EOF
rm -rf "${TEST_DIR}/runs_rrv"

JAIPH_RUNS_DIR="runs_rrv" e2e::run "recover_receives_output.jh" >/dev/null 2>&1

# The catch binding is the failed step's stdout CAPTURE PATH (a `.out` file),
# not the log bytes; the recover body reads the content from that path.
e2e::assert_file_exists "${TEST_DIR}/recover_received.txt" "recover block ran"
bound_path="$(<"${TEST_DIR}/recover_received.txt")"
case "${bound_path}" in
  /*.out) : ;;
  *) e2e::fail "binding must be an absolute *.out capture path, got: ${bound_path}" ;;
esac
e2e::assert_equals "$(<"${bound_path}")" "analysis-stdout-log" "bound path's file holds the failed rule stdout"
e2e::pass "ensure...recover: catch block binds the capture path"

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
