#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "log_logerr"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "log writes to stdout, logerr writes to stderr"

# Given — a workflow using both log and logerr
e2e::file "log_split.jh" <<'EOF'
script done_impl() {
  echo "done"
}
workflow default {
  log "stdout-msg"
  logerr "stderr-msg"
  run done_impl
}
EOF

# Build and run the compiled script to verify fd routing.
# Source stdlib from the E2E install, then call impl directly
# (outside run_step, so stdout/stderr aren't captured to artifact files).
jaiph build "${TEST_DIR}/log_split.jh" >/dev/null
compiled="${TEST_DIR}/log_split.sh"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
(
  export JAIPH_STDLIB="${JAIPH_E2E_BIN_DIR}/jaiph_stdlib.sh"
  source "${compiled}"
  log_split::default::impl
) >"${stdout_file}" 2>"${stderr_file}" || true
run_stdout="$(<"${stdout_file}")"
# Strip event marker lines from stderr for assertion purposes — events are
# metadata routed via fd 3 (or fd 2 fallback) and may contain message text.
run_stderr="$(grep -v "^__JAIPH_EVENT__" "${stderr_file}" || true)"
rm -f "${stdout_file}" "${stderr_file}"

# Then — log message on stdout, not on stderr (excluding event metadata)
e2e::assert_contains "${run_stdout}" "stdout-msg" "log message appears on stdout"
if [[ "${run_stderr}" == *"stdout-msg"* ]]; then
  e2e::fail "log message must not appear on stderr"
fi
e2e::pass "log message does not appear on stderr"

# Then — logerr message on stderr, not on stdout
e2e::assert_contains "${run_stderr}" "stderr-msg" "logerr message appears on stderr"
if [[ "${run_stdout}" == *"stderr-msg"* ]]; then
  e2e::fail "logerr message must not appear on stdout"
fi
e2e::pass "logerr message does not appear on stdout"

e2e::section "log/logerr run artifacts"

# Given
e2e::file "log_artifacts.jh" <<'EOF'
script done_impl() {
  echo "done"
}
workflow default {
  log "artifact-stdout"
  logerr "artifact-stderr"
  run done_impl
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
e2e::assert_contains "${out_content}" "artifact-stdout" "default .out aggregates inline log stdout text"
if [[ "${out_content}" == *"script"* ]] || [[ "${out_content}" == *"done"* ]]; then
  e2e::fail "default .out must not include script stdout (script has its own step .out)"
fi
e2e::pass "default .out excludes script stdout"

# Check .err file for logerr content
if [[ ${#err_files[@]} -ge 1 ]]; then
  err_content="$(<"${err_files[0]}")"
  e2e::assert_contains "${err_content}" "artifact-stderr" "default .err aggregates inline logerr text"
else
  e2e::fail "expected at least one .err file for default workflow (logerr output)"
fi

[[ ${#step_out_files[@]} -ge 1 ]] || e2e::fail "expected script .out artifact for done_impl"
e2e::assert_contains "$(<"${step_out_files[0]}")" "done" "script output remains captured in step .out"

summary_file="${run_dir}run_summary.jsonl"
e2e::assert_file_exists "${summary_file}" "run summary exists for log/logerr contract"
summary_content="$(<"${summary_file}")"
e2e::assert_contains "${summary_content}" "\"type\":\"LOG\"" "summary includes LOG event"
e2e::assert_contains "${summary_content}" "artifact-stdout" "summary captures log message text"
e2e::assert_contains "${summary_content}" "\"type\":\"LOGERR\"" "summary includes LOGERR event"
e2e::assert_contains "${summary_content}" "artifact-stderr" "summary captures logerr message text"
