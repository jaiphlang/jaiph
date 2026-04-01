#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "run_artifacts"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "run artifacts on workflow failure"

# Given
e2e::file "artifacts_fail.jh" <<'EOF'
script ok_step_impl = ```
echo "ok-out"
```
rule ok_step() {
  run ok_step_impl()
}

script failing_step_impl = ```
echo "bad-out"
echo "bad-err" >&2
exit 1
```
rule failing_step() {
  run failing_step_impl()
}

workflow default() {
  ensure ok_step()
  ensure failing_step()
}
EOF
rm -rf "${TEST_DIR}/runs_out"

# When
run_err_file="$(mktemp)"
if JAIPH_RUNS_DIR="${TEST_DIR}/runs_out" jaiph run "${TEST_DIR}/artifacts_fail.jh" 2>"${run_err_file}"; then
  cat "${run_err_file}" >&2
  rm -f "${run_err_file}"
  e2e::fail "jaiph run should fail to produce failure artifacts"
fi
run_err_out="$(cat "${run_err_file}")"
rm -f "${run_err_file}"

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_out" "artifacts_fail.jh")"
summary_file="${run_dir}run_summary.jsonl"

# Then
e2e::assert_contains "${run_err_out}" "Logs:" "failure output includes logs location"
e2e::assert_contains "${run_err_out}" "Summary:" "failure output includes summary location"
e2e::assert_contains "${run_err_out}" "err:" "failure output includes failing stderr file path"
e2e::assert_file_exists "${summary_file}" "run summary file is created"
summary_content="$(<"${summary_file}")"
e2e::assert_contains "${summary_content}" "\"type\":\"STEP_END\"" "summary records step end events"
e2e::assert_contains "${summary_content}" "\"status\":1" "summary records non-zero failing step status"

# Assert full .out and .err file content from script-backed rules
e2e::expect_run_file_at "${TEST_DIR}/runs_out" "artifacts_fail.jh" "000003-script__ok_step_impl.out" "ok-out"
e2e::expect_run_file_at "${TEST_DIR}/runs_out" "artifacts_fail.jh" "000005-script__failing_step_impl.out" "bad-out"
e2e::expect_run_file_at "${TEST_DIR}/runs_out" "artifacts_fail.jh" "000005-script__failing_step_impl.err" "bad-err"

e2e::section "mocked prompt transcript in workflow .out; script stdout on script step .out"

e2e::file "prompt_then_script.jh" <<'EOF'
script echo_line_impl = ```
echo "script-step-out"
```
workflow default() {
  _ = prompt "e2e-artifacts-prompt-line"
  run echo_line_impl()
}
EOF
rm -rf "${TEST_DIR}/runs_prompt_script"
mock_resp="${TEST_DIR}/mock_prompt_once.txt"
printf '%s\n' "mock-final-line" >"${mock_resp}"

JAIPH_RUNS_DIR="${TEST_DIR}/runs_prompt_script" \
  JAIPH_TEST_MODE=1 \
  JAIPH_MOCK_RESPONSES_FILE="${mock_resp}" \
  jaiph run "${TEST_DIR}/prompt_then_script.jh" >/dev/null

run_dir_ps="$(e2e::run_dir_at "${TEST_DIR}/runs_prompt_script" "prompt_then_script.jh")"
shopt -s nullglob
wf_outs=( "${run_dir_ps}"*workflow__default.out )
sc_outs=( "${run_dir_ps}"*script__echo_line_impl.out )
shopt -u nullglob
[[ ${#wf_outs[@]} -ge 1 ]] || e2e::fail "expected workflow default .out"
[[ ${#sc_outs[@]} -ge 1 ]] || e2e::fail "expected script echo_line_impl .out"

wf_out="$(<"${wf_outs[0]}")"
e2e::assert_contains "${wf_out}" "Command:" "workflow .out includes prompt command transcript"
e2e::assert_contains "${wf_out}" "Prompt:" "workflow .out includes prompt header"
e2e::assert_contains "${wf_out}" "e2e-artifacts-prompt-line" "workflow .out includes prompt body"
e2e::assert_contains "${wf_out}" "mock-final-line" "workflow .out includes mocked prompt final text"

e2e::assert_contains "$(<"${sc_outs[0]}")" "script-step-out" "script step .out captures script stdout only"
e2e::pass "prompt + script artifacts: split between workflow .out and script .out"
