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

workflow do_a() {
  run write_a
}

workflow do_b() {
  run write_b
}

workflow default() {
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
workflow fail_a() {
  fail "error-a"
}

workflow fail_b() {
  fail "error-b"
}

workflow default() {
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

workflow slow() {
  log "slow-done"
}

workflow default() {
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
workflow helper() {
  log "hi"
}

workflow default() {
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

# --- run async sibling depth in progress tree ---

e2e::section "run async sibling workflows have same tree depth"

e2e::file "sibling_depth.jh" <<'EOF'
script write_x() {
  echo "x" > x.txt
}

script write_y() {
  echo "y" > y.txt
}

workflow branch_x() {
  run write_x
}

workflow branch_y() {
  run write_y
}

workflow default() {
  run async branch_x
  run async branch_y
}
EOF

depth_output="$(NO_COLOR=1 e2e::run "sibling_depth.jh" 2>&1)"

# Extract the first "▸ workflow branch_x/y" start lines from the progress output.
# Both sibling async workflows should have the same leading whitespace (same depth).
branch_x_line="$(echo "$depth_output" | grep '▸ workflow branch_x' | head -1)"
branch_y_line="$(echo "$depth_output" | grep '▸ workflow branch_y' | head -1)"

if [[ -z "$branch_x_line" ]] || [[ -z "$branch_y_line" ]]; then
  printf "Output was:\n%s\n" "$depth_output" >&2
  e2e::fail "expected both workflow start lines in progress output"
fi

# Extract leading whitespace before the ▸ marker.
indent_x="${branch_x_line%%▸*}"
indent_y="${branch_y_line%%▸*}"

if [[ "$indent_x" != "$indent_y" ]]; then
  printf "branch_x indent: [%s]\n" "$indent_x" >&2
  printf "branch_y indent: [%s]\n" "$indent_y" >&2
  printf "Output was:\n%s\n" "$depth_output" >&2
  e2e::fail "async sibling workflows should have same indentation"
fi
e2e::pass "async sibling workflows render at same tree depth"
