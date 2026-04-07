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

e2e::expect_stdout "$run_output" <<'EXPECTED'

Jaiph: Running fanout.jh

workflow default
① ▸ workflow do_a
① ·   ▸ script write_a
② ▸ workflow do_b
② ·   ▸ script write_b
  ℹ done
① ·   ✓ script write_a (<time>)
① ✓ workflow do_a (<time>)
② ·   ✓ script write_b (<time>)
② ✓ workflow do_b (<time>)

✓ PASS workflow default (<time>)
EXPECTED

e2e::expect_out "fanout.jh" "default" "done"
e2e::expect_out "fanout.jh" "do_a" ""
e2e::expect_out "fanout.jh" "do_b" ""

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

# FAIL output includes absolute run-dir paths which vary per invocation
e2e::assert_contains "$fail_output" "error-a" "first failure message is surfaced"
e2e::assert_contains "$fail_output" "fail_b" "second async branch shown failing in progress tree"

e2e::expect_out "multi_fail.jh" "fail_a" ""
e2e::expect_out "multi_fail.jh" "fail_b" ""

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

interleave_output="$(e2e::run "async_interleave.jh" 2>&1)"

if [[ ! -f "${TEST_DIR}/sync_marker.txt" ]]; then
  e2e::fail "sync step should execute while async steps are pending"
fi
e2e::pass "sync steps run before implicit join"

e2e::expect_stdout "$interleave_output" <<'EXPECTED'

Jaiph: Running async_interleave.jh

workflow default
① ▸ workflow slow
  ▸ script write_marker
① ·   ℹ slow-done
① ✓ workflow slow (<time>)
  ✓ script write_marker (<time>)

✓ PASS workflow default (<time>)
EXPECTED

e2e::expect_out "async_interleave.jh" "default" "slow-done"
e2e::expect_out "async_interleave.jh" "slow" "slow-done"

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
# Error line includes absolute source path which varies per invocation
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

e2e::expect_stdout "$depth_output" <<'EXPECTED'

Jaiph: Running sibling_depth.jh

workflow default
① ▸ workflow branch_x
① ·   ▸ script write_x
② ▸ workflow branch_y
② ·   ▸ script write_y
① ·   ✓ script write_x (<time>)
① ✓ workflow branch_x (<time>)
② ·   ✓ script write_y (<time>)
② ✓ workflow branch_y (<time>)

✓ PASS workflow default (<time>)
EXPECTED

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

e2e::expect_stdout "$circled_output" <<'EXPECTED'

Jaiph: Running circled.jh

workflow default
① ▸ workflow alpha
② ▸ workflow beta
① ·   ℹ alpha-done
② ·   ℹ beta-done
① ✓ workflow alpha (<time>)
② ✓ workflow beta (<time>)

✓ PASS workflow default (<time>)
EXPECTED

e2e::expect_out "circled.jh" "default" "alpha-done
beta-done"
e2e::expect_out "circled.jh" "alpha" "alpha-done"
e2e::expect_out "circled.jh" "beta" "beta-done"

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

e2e::expect_stdout "$nested_output" <<'EXPECTED'

Jaiph: Running nested_async.jh

workflow default
① ▸ workflow outer
① · ① ▸ workflow inner_a
① · ② ▸ workflow inner_b
② ▸ workflow side
① · ① ·   ℹ inner-a
① · ② ·   ℹ inner-b
② ·   ℹ side-done
① · ① ✓ workflow inner_a (<time>)
① · ② ✓ workflow inner_b (<time>)
② ✓ workflow side (<time>)
① ✓ workflow outer (<time>)

✓ PASS workflow default (<time>)
EXPECTED

e2e::expect_out "nested_async.jh" "default" "inner-a
inner-b
side-done"
e2e::expect_out "nested_async.jh" "inner_a" "inner-a"
e2e::expect_out "nested_async.jh" "inner_b" "inner-b"
e2e::expect_out "nested_async.jh" "side" "side-done"
