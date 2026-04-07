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
script write_a = `echo "a" > a.txt`

script write_b = `echo "b" > b.txt`

workflow do_a() {
  run write_a()
}

workflow do_b() {
  run write_b()
}

workflow default() {
  run async do_a()
  run async do_b()
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
  run async fail_a()
  run async fail_b()
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
script write_marker = `echo "ran" > sync_marker.txt`

workflow slow() {
  log "slow-done"
}

workflow default() {
  run async slow()
  run write_marker()
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
  x = run async helper()
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
script write_x = `echo "x" > x.txt`

script write_y = `echo "y" > y.txt`

workflow branch_x() {
  run write_x()
}

workflow branch_y() {
  run write_y()
}

workflow default() {
  run async branch_x()
  run async branch_y()
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

# Extract leading text before the ▸ marker. With circled async numbers the
# prefixes differ (① vs ②) but their *length* must be equal (same depth).
indent_x="${branch_x_line%%▸*}"
indent_y="${branch_y_line%%▸*}"

if [[ "${#indent_x}" -ne "${#indent_y}" ]]; then
  printf "branch_x indent: [%s]\n" "$indent_x" >&2
  printf "branch_y indent: [%s]\n" "$indent_y" >&2
  printf "Output was:\n%s\n" "$depth_output" >&2
  e2e::fail "async sibling workflows should have same indentation depth"
fi
e2e::pass "async sibling workflows render at same tree depth"

# --- circled numbers on async branches ---

e2e::section "run async circled numbers in progress tree"

e2e::file "circled.jh" <<'EOF'
workflow alpha() {
  log "alpha-done"
}

workflow beta() {
  log "beta-done"
}

workflow default() {
  run async alpha()
  run async beta()
}
EOF

circled_output="$(NO_COLOR=1 e2e::run "circled.jh" 2>&1)"

# ① should prefix the first async branch (alpha)
# non-deterministic interleaving: assert_contains is required
e2e::assert_contains "$circled_output" "①" "circled ① appears for first async branch"
# ② should prefix the second async branch (beta)
e2e::assert_contains "$circled_output" "②" "circled ② appears for second async branch"
# Non-async lines (root workflow, PASS line) must NOT have circled numbers
pass_line="$(echo "$circled_output" | grep 'PASS')"
if echo "$pass_line" | LC_ALL=en_US.UTF-8 grep -q '[①②③④⑤⑥⑦⑧⑨⑩]'; then
  e2e::fail "PASS line should not have circled number prefix"
fi
e2e::pass "non-async lines have no circled number"

# --- nested async with circled numbers ---

e2e::section "nested run async circled numbers"

e2e::file "nested_async.jh" <<'EOF'
workflow inner_a() {
  log "inner-a"
}

workflow inner_b() {
  log "inner-b"
}

workflow outer() {
  run async inner_a()
  run async inner_b()
}

workflow side() {
  log "side-done"
}

workflow default() {
  run async outer()
  run async side()
}
EOF

nested_output="$(NO_COLOR=1 e2e::run "nested_async.jh" 2>&1)"

# Outer async branches get ① and ②
e2e::assert_contains "$nested_output" "①" "outer ① present"
e2e::assert_contains "$nested_output" "②" "outer ② present"

# Nested async inside outer() should produce lines with two circled numbers.
# The inner branches of outer() get their own ① ② at the nested indent level.
# Look for a line containing two circled-number characters (① · ① or ① · ②).
# non-deterministic interleaving: assert_contains is required
nested_line="$(echo "$nested_output" | LC_ALL=en_US.UTF-8 grep '①.*·.*①\|①.*·.*②' | head -1)"
if [[ -z "$nested_line" ]]; then
  printf "Output was:\n%s\n" "$nested_output" >&2
  e2e::fail "expected nested async lines with two circled numbers (e.g. ① · ① ...)"
fi
e2e::pass "nested async branches show two levels of circled numbers"
