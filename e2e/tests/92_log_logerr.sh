#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "log_logerr"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "log/logerr run artifacts"

# Given
e2e::file "log_artifacts.jh" <<'EOF'
script done_impl = "echo \"done\""
workflow default {
  log "artifact-stdout"
  logerr "artifact-stderr"
  run done_impl()
}
EOF
rm -rf "${TEST_DIR}/runs_log"

# When
JAIPH_RUNS_DIR="${TEST_DIR}/runs_log" jaiph run "${TEST_DIR}/log_artifacts.jh" >/dev/null 2>&1 || true

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_log" "log_artifacts.jh")"

# Then — find the workflow .out and .err files
shopt -s nullglob
out_files=( "${run_dir}"*default.out )
err_files=( "${run_dir}"*default.err )
step_out_files=( "${run_dir}"*script__done_impl.out )
shopt -u nullglob

[[ ${#out_files[@]} -ge 1 ]] || e2e::fail "expected at least one .out file for default workflow"
out_content="$(<"${out_files[0]}")"
e2e::assert_equals "${out_content}" "artifact-stdout" "default .out aggregates inline log stdout text"
if [[ "${out_content}" == *"script"* ]] || [[ "${out_content}" == *"done"* ]]; then
  e2e::fail "default .out must not include script stdout (script has its own step .out)"
fi
e2e::pass "default .out excludes script stdout"

# Check .err file for logerr content
if [[ ${#err_files[@]} -ge 1 ]]; then
  err_content="$(<"${err_files[0]}")"
  e2e::assert_equals "${err_content}" "artifact-stderr" "default .err aggregates inline logerr text"
else
  e2e::fail "expected at least one .err file for default workflow (logerr output)"
fi

[[ ${#step_out_files[@]} -ge 1 ]] || e2e::fail "expected script .out artifact for done_impl"
e2e::assert_equals "$(<"${step_out_files[0]}")" "done" "script output remains captured in step .out"

summary_file="${run_dir}run_summary.jsonl"
e2e::assert_file_exists "${summary_file}" "run summary exists for log/logerr contract"
summary_content="$(<"${summary_file}")"
# assert_contains: run_summary.jsonl is variable-length with timestamps and event fields
e2e::assert_contains "${summary_content}" "\"type\":\"LOG\"" "summary includes LOG event"
e2e::assert_contains "${summary_content}" "artifact-stdout" "summary captures log message text"
e2e::assert_contains "${summary_content}" "\"type\":\"LOGERR\"" "summary includes LOGERR event"
e2e::assert_contains "${summary_content}" "artifact-stderr" "summary captures logerr message text"
