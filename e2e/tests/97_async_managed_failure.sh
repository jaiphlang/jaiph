#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "async_managed_failure"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "wait fails when any async managed run fails"

e2e::file "async_managed_failure.jh" <<'EOF'
script good_impl() {
  sleep 0.05
  echo "good" > good.txt
}

workflow good {
  run good_impl
}

workflow bad {
  fail "bad-run"
}

script should_not_run_impl() {
  echo "should-not-run" > after_wait.txt
}

workflow default {
  run good &
  run bad &
  wait
  run should_not_run_impl
}
EOF

set +e
run_output="$(e2e::run "async_managed_failure.jh" 2>&1)"
run_status=$?
set -e

if [[ "$run_status" -eq 0 ]]; then
  e2e::fail "expected non-zero exit when one async managed run fails"
fi
e2e::pass "workflow exits non-zero when async managed run fails"

if [[ -f "${TEST_DIR}/after_wait.txt" ]]; then
  e2e::fail "wait did not stop workflow after failed async managed run"
fi
e2e::pass "statements after wait are not executed on async managed failure"

e2e::assert_contains "$run_output" "bad-run" "failed async run reason is surfaced to caller"

