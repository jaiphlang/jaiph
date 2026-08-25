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

def do_a() {
  run write_a()
}

def do_b() {
  run write_b()
}

export def main() {
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

export def main
 ₁▸ def do_a
 ₁·   ▸ script write_a
 ₂▸ def do_b
 ₂·   ▸ script write_b
  ℹ done
 ₁·   ✓ script write_a (<time>)
 ₁✓ def do_a(<time>)
 ₂·   ✓ script write_b (<time>)
 ₂✓ def do_b(<time>)

✓ PASS export def main (<time>)
EXPECTED

e2e::expect_out "fanout.jh" "default" "done"
e2e::expect_out "fanout.jh" "do_a" ""
e2e::expect_out "fanout.jh" "do_b" ""

# --- run async failure aggregation ---

e2e::section "run async multi-failure aggregation"

e2e::file "multi_fail.jh" <<'EOF'
def fail_a() {
  fail "error-a"
}

def fail_b() {
  fail "error-b"
}

export def main() {
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

def slow() {
  log "slow-done"
}

export def main() {
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

export def main
 ₁▸ def slow
  ▸ script write_marker
 ₁·   ℹ slow-done
 ₁✓ def slow(<time>)
  ✓ script write_marker (<time>)

✓ PASS export def main (<time>)
EXPECTED

e2e::expect_out "async_interleave.jh" "default" "slow-done"
e2e::expect_out "async_interleave.jh" "slow" "slow-done"

# --- capture + run async returns handle that resolves on read ---

e2e::section "capture + run async returns handle"

e2e::file "capture_async.jh" <<'EOF'
def helper() {
  return "hello"
}

export def main() {
  const x = run async helper()
  log x
}
EOF

capture_output="$(e2e::run "capture_async.jh" 2>&1)"
capture_status=$?

if [[ "$capture_status" -ne 0 ]]; then
  e2e::fail "expected capture + run async to succeed, got exit $capture_status"
fi
e2e::pass "capture + run async succeeds"

e2e::expect_out "capture_async.jh" "default" "hello"

# --- run async sibling depth in progress tree ---

e2e::section "run async sibling workflows have same tree depth"

e2e::file "sibling_depth.jh" <<'EOF'
script write_x = `echo "x" > x.txt`

script write_y = `echo "y" > y.txt`

def branch_x() {
  run write_x()
}

def branch_y() {
  run write_y()
}

export def main() {
  run async branch_x()
  run async branch_y()
}
EOF

depth_output="$(NO_COLOR=1 e2e::run "sibling_depth.jh" 2>&1)"

e2e::expect_stdout "$depth_output" <<'EXPECTED'

Jaiph: Running sibling_depth.jh

export def main
 ₁▸ def branch_x
 ₁·   ▸ script write_x
 ₂▸ def branch_y
 ₂·   ▸ script write_y
 ₁·   ✓ script write_x (<time>)
 ₁✓ def branch_x(<time>)
 ₂·   ✓ script write_y (<time>)
 ₂✓ def branch_y(<time>)

✓ PASS export def main (<time>)
EXPECTED

# --- circled numbers on async branches ---

e2e::section "run async circled numbers in progress tree"

e2e::file "circled.jh" <<'EOF'
def alpha() {
  log "alpha-done"
}

def beta() {
  log "beta-done"
}

export def main() {
  run async alpha()
  run async beta()
}
EOF

circled_output="$(NO_COLOR=1 e2e::run "circled.jh" 2>&1)"

e2e::expect_stdout "$circled_output" <<'EXPECTED'

Jaiph: Running circled.jh

export def main
 ₁▸ def alpha
 ₂▸ def beta
 ₁·   ℹ alpha-done
 ₂·   ℹ beta-done
 ₁✓ def alpha(<time>)
 ₂✓ def beta(<time>)

✓ PASS export def main (<time>)
EXPECTED

e2e::expect_out "circled.jh" "default" "alpha-done
beta-done"
e2e::expect_out "circled.jh" "alpha" "alpha-done"
e2e::expect_out "circled.jh" "beta" "beta-done"

# --- nested async with circled numbers ---

e2e::section "nested run async circled numbers"

e2e::file "nested_async.jh" <<'EOF'
def inner_a() {
  log "inner-a"
}

def inner_b() {
  log "inner-b"
}

def outer() {
  run async inner_a()
  run async inner_b()
}

def side() {
  log "side-done"
}

export def main() {
  run async outer()
  run async side()
}
EOF

nested_output="$(NO_COLOR=1 e2e::run "nested_async.jh" 2>&1)"

e2e::expect_stdout "$nested_output" <<'EXPECTED'

Jaiph: Running nested_async.jh

export def main
 ₁▸ def outer
 ₁·  ₁▸ def inner_a
 ₁·  ₂▸ def inner_b
 ₂▸ def side
 ₁·  ₁·   ℹ inner-a
 ₁·  ₂·   ℹ inner-b
 ₂·   ℹ side-done
 ₁·  ₁✓ def inner_a(<time>)
 ₁·  ₂✓ def inner_b(<time>)
 ₂✓ def side(<time>)
 ₁✓ def outer(<time>)

✓ PASS export def main (<time>)
EXPECTED

e2e::expect_out "nested_async.jh" "default" "inner-a
inner-b
side-done"
e2e::expect_out "nested_async.jh" "inner_a" "inner-a"
e2e::expect_out "nested_async.jh" "inner_b" "inner-b"
e2e::expect_out "nested_async.jh" "side" "side-done"
