#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "step_idle_warn"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "leaf script idle output warning"

e2e::file "idle_warn.jh" <<'EOF'
script quiet = `echo start; sleep 3; echo done`
workflow default() {
  run quiet()
}
EOF
rm -rf "${TEST_DIR}/runs_idle"

JAIPH_RUNS_DIR="${TEST_DIR}/runs_idle" \
  JAIPH_DOCKER_ENABLED=false \
  JAIPH_STEP_IDLE_WARN_SEC=1 \
  JAIPH_STEP_IDLE_WARN_CHECK_MS=500 \
  jaiph run "${TEST_DIR}/idle_warn.jh" >/tmp/jaiph-idle-out.txt 2>/tmp/jaiph-idle-err.txt

out_content="$(< /tmp/jaiph-idle-out.txt)"
e2e::assert_contains "${out_content}" "no new output for" "idle warning mentions stalled output"
e2e::assert_contains "${out_content}" "script quiet" "idle warning names the leaf script step"
warn_count="$(printf '%s' "${out_content}" | grep -c 'no new output for' || true)"
[[ "${warn_count}" -ge 2 ]] || e2e::fail "expected incremental idle warnings during 3s silence (got ${warn_count})"

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_idle" "idle_warn.jh")"
summary_file="${run_dir}run_summary.jsonl"
summary_content="$(<"${summary_file}")"
e2e::assert_contains "${summary_content}" "\"type\":\"LOGWARN\"" "summary includes idle LOGWARN event"
e2e::assert_contains "${summary_content}" "no new output for" "summary captures idle warning text"

e2e::pass "leaf script idle output warning"
