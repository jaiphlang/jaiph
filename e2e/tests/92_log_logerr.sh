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
workflow default {
  log "stdout-msg"
  logerr "stderr-msg"
  echo "done"
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
workflow default {
  log "artifact-stdout"
  logerr "artifact-stderr"
  echo "done"
}
EOF
rm -rf "${TEST_DIR}/runs_log"

# When
JAIPH_RUNS_DIR="runs_log" jaiph run "${TEST_DIR}/log_artifacts.jh" >/dev/null 2>&1 || true

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_log" "log_artifacts.jh")"

# Then — find the workflow .out and .err files
shopt -s nullglob
out_files=( "${run_dir}"*default.out )
err_files=( "${run_dir}"*default.err )
shopt -u nullglob

[[ ${#out_files[@]} -ge 1 ]] || e2e::fail "expected at least one .out file for default workflow"
out_content="$(<"${out_files[0]}")"

e2e::assert_contains "${out_content}" "artifact-stdout" "log message appears in .out artifact"
if [[ "${out_content}" == *"artifact-stderr"* ]]; then
  e2e::fail "logerr message must not appear in .out artifact"
fi
e2e::pass "logerr message does not appear in .out artifact"

# Check .err file for logerr content
if [[ ${#err_files[@]} -ge 1 ]]; then
  err_content="$(<"${err_files[0]}")"
  e2e::assert_contains "${err_content}" "artifact-stderr" "logerr message appears in .err artifact"
  if [[ "${err_content}" == *"artifact-stdout"* ]]; then
    e2e::fail "log message must not appear in .err artifact"
  fi
  e2e::pass "log message does not appear in .err artifact"
else
  e2e::fail "expected at least one .err file for default workflow (logerr output)"
fi
