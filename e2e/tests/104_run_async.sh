#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "run_async"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# --- run async fanout/join ---

e2e::section "run async fanout with implicit join"

e2e::file "fanout.jh" <<'EOF'
script write_a() {
  echo "a" > a.txt
}

script write_b() {
  echo "b" > b.txt
}

workflow do_a {
  run write_a
}

workflow do_b {
  run write_b
}

workflow default {
  run async do_a
  run async do_b
  log "done"
}
EOF

run_output="$(e2e::run "fanout.jh" 2>&1)"

if [[ ! -f "${TEST_DIR}/a.txt" ]] || [[ ! -f "${TEST_DIR}/b.txt" ]]; then
  e2e::fail "both async branches should have written their files"
fi
e2e::pass "both async branches executed"

e2e::assert_contains "$run_output" "done" "log after async steps runs when all succeed"

# --- run async failure aggregation ---

e2e::section "run async multi-failure aggregation"

e2e::file "multi_fail.jh" <<'EOF'
workflow fail_a {
  fail "error-a"
}

workflow fail_b {
  fail "error-b"
}

workflow default {
  run async fail_a
  run async fail_b
}
EOF

set +e
fail_output="$(e2e::run "multi_fail.jh" 2>&1)"
fail_status=$?
set -e

if [[ "$fail_status" -eq 0 ]]; then
  e2e::fail "expected non-zero exit when async steps fail"
fi
e2e::pass "workflow exits non-zero on async failure"

e2e::assert_contains "$fail_output" "error-a" "first failure message is surfaced"
e2e::assert_contains "$fail_output" "fail_b" "second async branch shown failing in progress tree"

# --- run async with sync steps: sync steps run before implicit join ---

e2e::section "run async with interleaved sync steps"

e2e::file "async_interleave.jh" <<'EOF'
script write_marker() {
  echo "ran" > sync_marker.txt
}

workflow slow {
  log "slow-done"
}

workflow default {
  run async slow
  run write_marker
}
EOF

e2e::run "async_interleave.jh" >/dev/null 2>&1

if [[ ! -f "${TEST_DIR}/sync_marker.txt" ]]; then
  e2e::fail "sync step should execute while async steps are pending"
fi
e2e::pass "sync steps run before implicit join"

# --- capture + run async is rejected at parse time ---

e2e::section "capture + run async parse error"

e2e::file "capture_async.jh" <<'EOF'
workflow helper {
  log "hi"
}

workflow default {
  x = run async helper
}
EOF

set +e
capture_output="$(e2e::run "capture_async.jh" 2>&1)"
capture_status=$?
set -e

if [[ "$capture_status" -eq 0 ]]; then
  e2e::fail "expected parse error for capture + run async"
fi
e2e::assert_contains "$capture_output" "capture is not supported with run async" "capture + run async diagnostic"
