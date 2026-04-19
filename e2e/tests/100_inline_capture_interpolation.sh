#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "inline_capture"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# --------------------------------------------------------------------------
# Section 1: ${run ref} inline capture in log
# --------------------------------------------------------------------------

e2e::section "inline run capture in log"

e2e::file "ic_run_log.jh" <<'EOF'
script greet = `echo "hello"`

workflow default() {
  log "got: ${run greet()}"
}
EOF

rm -rf "${TEST_DIR}/runs_ic1"
JAIPH_RUNS_DIR="${TEST_DIR}/runs_ic1" jaiph run "${TEST_DIR}/ic_run_log.jh" >/dev/null 2>&1 || true

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_ic1" "ic_run_log.jh")"
summary_file="${run_dir}run_summary.jsonl"
e2e::assert_file_exists "${summary_file}" "run summary exists"
summary_content="$(<"${summary_file}")"
# assert_contains: run_summary.jsonl is variable-length with timestamps
e2e::assert_contains "${summary_content}" '"type":"LOG"' "summary has LOG event"
e2e::assert_contains "${summary_content}" "got: hello" "inline run capture resolved in log"

# --------------------------------------------------------------------------
# Section 2: ${run ref} inline capture in log (workflow)
# --------------------------------------------------------------------------

e2e::section "inline run capture in log (workflow)"

e2e::file "ic_ensure_log.jh" <<'EOF'
workflow check() {
  return "ok"
}

workflow default() {
  log "status: ${run check()}"
}
EOF

rm -rf "${TEST_DIR}/runs_ic2"
JAIPH_RUNS_DIR="${TEST_DIR}/runs_ic2" jaiph run "${TEST_DIR}/ic_ensure_log.jh" >/dev/null 2>&1 || true

run_dir2="$(e2e::run_dir_at "${TEST_DIR}/runs_ic2" "ic_ensure_log.jh")"
summary2="$(<"${run_dir2}run_summary.jsonl")"
# assert_contains: run_summary.jsonl is variable-length with timestamps
e2e::assert_contains "${summary2}" "status: ok" "inline run capture resolved in log (workflow)"

# --------------------------------------------------------------------------
# Section 3: ${run ref} with args
# --------------------------------------------------------------------------

e2e::section "inline run capture with args"

e2e::file "ic_run_args.jh" <<'EOF'
script greet = `echo "hi $1"`

workflow default() {
  log "said: ${run greet(world)}"
}
EOF

rm -rf "${TEST_DIR}/runs_ic3"
JAIPH_RUNS_DIR="${TEST_DIR}/runs_ic3" jaiph run "${TEST_DIR}/ic_run_args.jh" >/dev/null 2>&1 || true

run_dir3="$(e2e::run_dir_at "${TEST_DIR}/runs_ic3" "ic_run_args.jh")"
summary3="$(<"${run_dir3}run_summary.jsonl")"
# assert_contains: run_summary.jsonl is variable-length with timestamps
e2e::assert_contains "${summary3}" "said: hi world" "inline run capture with args"

# --------------------------------------------------------------------------
# Section 4: inline capture in return
# --------------------------------------------------------------------------

e2e::section "inline capture in return value"

e2e::file "ic_return.jh" <<'EOF'
script greet = `echo "hello"`

workflow helper() {
  return "${run greet()}"
}

workflow default() {
  const r = run helper()
  log "returned: ${r}"
}
EOF

rm -rf "${TEST_DIR}/runs_ic4"
JAIPH_RUNS_DIR="${TEST_DIR}/runs_ic4" jaiph run "${TEST_DIR}/ic_return.jh" >/dev/null 2>&1 || true

run_dir4="$(e2e::run_dir_at "${TEST_DIR}/runs_ic4" "ic_return.jh")"
summary4="$(<"${run_dir4}run_summary.jsonl")"
# assert_contains: run_summary.jsonl is variable-length with timestamps
e2e::assert_contains "${summary4}" "returned: hello" "inline capture in return propagates value"

# --------------------------------------------------------------------------
# Section 5: inline capture failure propagation
# --------------------------------------------------------------------------

e2e::section "inline capture failure propagation"

e2e::file "ic_fail_prop.jh" <<'EOF'
script bad = ```
echo "err" >&2
exit 1
```

workflow default() {
  log "got: ${run bad()}"
  log "should not reach"
}
EOF

rm -rf "${TEST_DIR}/runs_ic5"
if JAIPH_RUNS_DIR="${TEST_DIR}/runs_ic5" jaiph run "${TEST_DIR}/ic_fail_prop.jh" >/dev/null 2>&1; then
  e2e::fail "expected workflow to fail when inline capture fails"
fi
e2e::pass "inline capture failure propagates to parent workflow"

# --------------------------------------------------------------------------
# Section 6: mixed inline captures and variable interpolation
# --------------------------------------------------------------------------

e2e::section "mixed inline captures and variable interpolation"

e2e::file "ic_mixed.jh" <<'EOF'
script greet = `echo "hello"`

workflow default() {
  const name = "world"
  log "${run greet()} ${name}"
}
EOF

rm -rf "${TEST_DIR}/runs_ic6"
JAIPH_RUNS_DIR="${TEST_DIR}/runs_ic6" jaiph run "${TEST_DIR}/ic_mixed.jh" >/dev/null 2>&1 || true

run_dir6="$(e2e::run_dir_at "${TEST_DIR}/runs_ic6" "ic_mixed.jh")"
summary6="$(<"${run_dir6}run_summary.jsonl")"
# assert_contains: run_summary.jsonl is variable-length with timestamps
e2e::assert_contains "${summary6}" "hello world" "mixed inline capture and variable interpolation"

# --------------------------------------------------------------------------
# Section 7: compile-time rejection of nested inline captures
# --------------------------------------------------------------------------

e2e::section "compile rejects nested inline captures"

e2e::file "ic_nested.jh" <<'EOF'
script foo = `echo "a"`
script bar = `echo "b"`
workflow default() {
  log "got: ${run foo(${run bar()})}"
}
EOF

if jaiph run "${TEST_DIR}/ic_nested.jh" >/dev/null 2>&1; then
  e2e::fail "expected compile error for nested inline captures"
fi
e2e::pass "compile rejects nested inline captures"

# --------------------------------------------------------------------------
# Section 8: compile-time rejection of unknown ref in inline capture
# --------------------------------------------------------------------------

e2e::section "compile rejects unknown inline capture ref"

e2e::file "ic_unknown.jh" <<'EOF'
workflow default() {
  log "got: ${run nonexistent()}"
}
EOF

if jaiph run "${TEST_DIR}/ic_unknown.jh" >/dev/null 2>&1; then
  e2e::fail "expected compile error for unknown inline capture ref"
fi
e2e::pass "compile rejects unknown inline capture ref"

# --------------------------------------------------------------------------
# Section 9: jaiph test with inline captures
# --------------------------------------------------------------------------

e2e::section "jaiph test with inline captures"

# Remove invalid fixtures from workspace before jaiph test (it builds all .jh files).
rm -f "${TEST_DIR}/ic_nested.jh" "${TEST_DIR}/ic_unknown.jh"

e2e::file "ic_lib.jh" <<'EOF'
script greet = `echo "hello"`

workflow check_ok() {
  return "ok"
}

workflow run_capture_log() {
  log "got: ${run greet()}"
}

workflow ensure_capture_log() {
  log "status: ${run check_ok()}"
}

workflow capture_return() {
  return "${run greet()}"
}
EOF

e2e::file "ic_lib.test.jh" <<'EOF'
import "ic_lib.jh" as ic

test "inline run capture in log" {
  const out = run ic.run_capture_log()
  expect_contain out "got: hello"
}

test "inline run capture in log (workflow)" {
  const out = run ic.ensure_capture_log()
  expect_contain out "status: ok"
}

test "inline capture in return value" {
  const out = run ic.capture_return()
  expect_equal out "hello"
}
EOF

test_out="$(jaiph test "${TEST_DIR}/ic_lib.test.jh" 2>&1)" || {
  printf "%s\n" "${test_out}" >&2
  e2e::fail "ic_lib.test.jh should pass"
}
# assert_contains: test output includes dynamic run metadata
e2e::assert_contains "${test_out}" "inline run capture in log" "test case name in output"
e2e::pass "jaiph test with inline captures passes"
