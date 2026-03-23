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
rule check_ready {
  echo "rule-stdout-check"
  test -f ready.txt
  return "ready-value"
}

workflow fix_it {
  touch ready.txt
}

workflow default {
  val = ensure check_ready recover run fix_it
  echo "captured=$val"
}
EOF
rm -f "${TEST_DIR}/ready.txt"
rm -rf "${TEST_DIR}/runs_rcap"

JAIPH_RUNS_DIR="runs_rcap" e2e::run "recover_capture.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_rcap" "recover_capture.jh")"

# Assignment variable gets the return value from the successful rule call
shopt -s nullglob
wf_outs=( "${run_dir}"*default.out )
shopt -u nullglob
[[ ${#wf_outs[@]} -ge 1 ]] || e2e::fail "expected default .out artifact"
default_out="$(<"${wf_outs[0]}")"
e2e::assert_contains "${default_out}" "captured=ready-value" "ensure...recover capture = return value from successful rule"

# Rule stdout goes to artifacts, not into capture
if [[ "${default_out}" == *"rule-stdout-check"* ]]; then
  e2e::fail "rule stdout must NOT leak into capture variable"
fi
e2e::pass "ensure...recover capture: return value only"

# ===================================================================
e2e::section "ensure...recover: recover block receives rule return value (not stdout)"
# ===================================================================

rm -f "${TEST_DIR}/ready2.txt"
rm -f "${TEST_DIR}/recover_received.txt"

e2e::file "recover_receives_rv.jh" <<'EOF'
rule analyze {
  echo "analysis-stdout-log"
  # Populate value channel for recover on failed ensure attempt.
  echo "analysis-result-42" > "$JAIPH_RETURN_VALUE_FILE"
  test -f ready2.txt
}

workflow default {
  ensure analyze recover {
    echo "$1" > recover_received.txt
    touch ready2.txt
  }
}
EOF
rm -rf "${TEST_DIR}/runs_rrv"

JAIPH_RUNS_DIR="runs_rrv" e2e::run "recover_receives_rv.jh" >/dev/null 2>&1

# The recover block should receive the failed rule value channel as $1
e2e::assert_file_exists "${TEST_DIR}/recover_received.txt" "recover block ran"
recover_content="$(<"${TEST_DIR}/recover_received.txt")"
e2e::assert_equals "${recover_content}" "analysis-result-42" "recover block receives rule value channel (not stdout)"
e2e::pass "ensure...recover: recover block value semantics"

# ===================================================================
e2e::section "ensure...recover: rule stdout goes to artifacts"
# ===================================================================

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_rrv" "recover_receives_rv.jh")"

# Rule stdout goes to .out artifacts
shopt -s nullglob
rule_outs=( "${run_dir}"*analyze.out )
shopt -u nullglob
[[ ${#rule_outs[@]} -ge 1 ]] || e2e::fail "expected analyze .out artifact"
rule_out="$(<"${rule_outs[0]}")"
e2e::assert_contains "${rule_out}" "analysis-stdout-log" "rule stdout in .out artifact"
e2e::pass "ensure...recover: rule stdout in artifacts"
