#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "run_artifacts"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "run artifacts on workflow failure"
# Given
cat > "${TEST_DIR}/artifacts_fail.jh" <<'EOF'
rule ok_step {
  echo "ok-out"
}

rule failing_step {
  echo "bad-out"
  echo "bad-err" >&2
  exit 1
}

workflow default {
  ensure ok_step
  ensure failing_step
}
EOF
rm -rf "${TEST_DIR}/runs_out"

# When
run_err_file="$(mktemp)"
if JAIPH_RUNS_DIR="runs_out" jaiph run "${TEST_DIR}/artifacts_fail.jh" 2>"${run_err_file}"; then
  cat "${run_err_file}" >&2
  rm -f "${run_err_file}"
  e2e::fail "jaiph run should fail to produce failure artifacts"
fi
run_err_out="$(cat "${run_err_file}")"
rm -f "${run_err_file}"

shopt -s nullglob
date_dirs=( "${TEST_DIR}/runs_out"/*/ )
shopt -u nullglob
if [[ "${#date_dirs[@]}" -ne 1 ]]; then
  e2e::fail "expected exactly one date directory under runs_out, got ${#date_dirs[@]}"
fi
shopt -s nullglob
run_dirs=( "${date_dirs[0]}"*/ )
shopt -u nullglob
if [[ "${#run_dirs[@]}" -ne 1 ]]; then
  e2e::fail "expected exactly one run directory under date dir, got ${#run_dirs[@]}"
fi
run_dir="${run_dirs[0]%/}"
summary_file="${run_dir}/run_summary.jsonl"

shopt -s nullglob
out_files=( "${run_dir}"/*.out )
err_files=( "${run_dir}"/*.err )
shopt -u nullglob

# Then
e2e::assert_contains "${run_err_out}" "Logs:" "failure output includes logs location"
e2e::assert_contains "${run_err_out}" "Summary:" "failure output includes summary location"
e2e::assert_contains "${run_err_out}" "err:" "failure output includes failing stderr file path"
e2e::assert_file_exists "${summary_file}" "run summary file is created"
if [[ "${#out_files[@]}" -eq 0 ]]; then
  e2e::fail "expected at least one .out file in run artifacts"
fi
if [[ "${#err_files[@]}" -eq 0 ]]; then
  e2e::fail "expected at least one .err file in run artifacts"
fi
e2e::pass "run artifacts include .out and .err files"
summary_content="$(cat "${summary_file}")"
e2e::assert_contains "${summary_content}" "\"type\":\"STEP_END\"" "summary records step end events"
e2e::assert_contains "${summary_content}" "\"status\":1" "summary records non-zero failing step status"

# Assert full .out and .err file content
ok_out=( "${run_dir}"/*artifacts_fail__ok_step.out )
[[ ${#ok_out[@]} -eq 1 ]] || e2e::fail "expected one ok_step .out file"
e2e::assert_equals "$(<"${ok_out[0]}")" "ok-out" "ok_step .out full content"
fail_out=( "${run_dir}"/*artifacts_fail__failing_step.out )
[[ ${#fail_out[@]} -eq 1 ]] || e2e::fail "expected one failing_step .out file"
e2e::assert_equals "$(<"${fail_out[0]}")" "bad-out" "failing_step .out full content"
fail_err=( "${run_dir}"/*artifacts_fail__failing_step.err )
[[ ${#fail_err[@]} -eq 1 ]] || e2e::fail "expected one failing_step .err file"
e2e::assert_equals "$(<"${fail_err[0]}")" "bad-err" "failing_step .err full content"
