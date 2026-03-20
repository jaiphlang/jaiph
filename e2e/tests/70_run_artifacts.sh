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

# Assert full .out and .err file content
e2e::expect_run_file_at "${TEST_DIR}/runs_out" "artifacts_fail.jh" "000002-artifacts_fail__ok_step.out" "ok-out"
e2e::expect_run_file_at "${TEST_DIR}/runs_out" "artifacts_fail.jh" "000003-artifacts_fail__failing_step.out" "bad-out"
e2e::expect_run_file_at "${TEST_DIR}/runs_out" "artifacts_fail.jh" "000003-artifacts_fail__failing_step.err" "bad-err"
