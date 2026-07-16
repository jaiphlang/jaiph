#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "logwarn"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "logwarn run artifacts and tree event"

e2e::file "logwarn.jh" <<'EOF'
workflow default() {
  logwarn "artifact-warn"
}
EOF
rm -rf "${TEST_DIR}/runs_logwarn"

JAIPH_RUNS_DIR="${TEST_DIR}/runs_logwarn" jaiph run "${TEST_DIR}/logwarn.jh" >/tmp/jaiph-logwarn-out.txt 2>/tmp/jaiph-logwarn-err.txt || true

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_logwarn" "logwarn.jh")"

shopt -s nullglob
err_files=( "${run_dir}"*default.err )
shopt -u nullglob

[[ ${#err_files[@]} -ge 1 ]] || e2e::fail "expected at least one .err file for default workflow (logwarn output)"
err_content="$(<"${err_files[0]}")"
e2e::assert_equals "${err_content}" "artifact-warn" "default .err aggregates inline logwarn text"

summary_file="${run_dir}run_summary.jsonl"
e2e::assert_file_exists "${summary_file}" "run summary exists for logwarn contract"
summary_content="$(<"${summary_file}")"
e2e::assert_contains "${summary_content}" "\"type\":\"LOGWARN\"" "summary includes LOGWARN event"
e2e::assert_contains "${summary_content}" "artifact-warn" "summary captures logwarn message text"

out_content="$(< /tmp/jaiph-logwarn-out.txt)"
e2e::assert_contains "${out_content}" "artifact-warn" "TTY tree renders logwarn message"
e2e::assert_contains "${out_content}" $'\342\232\240' "TTY tree renders warning icon for logwarn"

e2e::pass "logwarn output contract"
