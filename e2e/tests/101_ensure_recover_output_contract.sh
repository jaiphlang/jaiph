#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover_output_contract"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# catch/recover bind the failed step's stdout CAPTURE PATH (a `NNNNNN-*.out`
# file under JAIPH_RUN_DIR), not the merged stdout+stderr bytes. Stderr stays
# in the sibling `.err`. Recover bodies read the bytes from disk (cp/cat the
# bound path) instead of receiving them as argv, so a huge log never hits
# ARG_MAX. Each section below cp's the bound `.out` and its sibling `.err` into
# witness files and asserts their full contents.

# Shared recover helper: `$1` is the bound stdout-capture path.
#   $2 <- the raw binding (must be an absolute *.out path)
#   $3 <- a copy of the stdout capture
#   $4 <- a copy of the sibling stderr capture
CAPTURE_SCRIPT='script capture_recover = ```
binding="$1"
printf "%s" "$binding" > "$2"
cp "$binding" "$3"
cp "${binding%.out}.err" "$4"
```'

# ===================================================================
# 1. Simple script failure through rule: stdout capture path + sibling .err
# ===================================================================
e2e::section "recover binds the stdout capture path; stderr in sibling .err"

e2e::file "simple_echo.jh" <<EOF
script simple_echo = \`\`\`
echo "Hello"
echo "Oops" >&2
exit 1
\`\`\`

${CAPTURE_SCRIPT}

def simple_echo_rule() {
  run simple_echo()
}

export def main() {
  run simple_echo_rule() catch (failure) {
    run capture_recover(failure, "binding_simple.txt", "out_simple.txt", "err_simple.txt")
  }
}
EOF

rm -f "${TEST_DIR}/binding_simple.txt" "${TEST_DIR}/out_simple.txt" "${TEST_DIR}/err_simple.txt"
e2e::run "simple_echo.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/binding_simple.txt" "recover ran and recorded the binding"
binding="$(<"${TEST_DIR}/binding_simple.txt")"
case "${binding}" in
  /*.out) : ;;
  *) e2e::fail "binding must be an absolute *.out capture path, got: ${binding}" ;;
esac
if [[ "${binding}" == *Hello* ]]; then
  e2e::fail "binding must be a path, not the log content: ${binding}"
fi
e2e::assert_equals "$(<"${TEST_DIR}/out_simple.txt")" "$(printf 'Hello')" "stdout capture holds script stdout"
e2e::assert_equals "$(<"${TEST_DIR}/err_simple.txt")" "$(printf 'Oops')" "sibling .err holds script stderr"
e2e::pass "simple script failure: stdout capture path + sibling .err"

# ===================================================================
# 2. Nested rule + script failure aggregation
# ===================================================================
e2e::section "recover capture aggregates nested rule log + script output"

e2e::file "nested_payload.jh" <<EOF
script failing_script = \`\`\`
echo "nested-stdout"
echo "nested-stderr" >&2
exit 1
\`\`\`

${CAPTURE_SCRIPT}

def inner() {
  run failing_script()
}

def outer() {
  log "outer start"
  run inner()
}

export def main() {
  run outer() catch (failure) {
    run capture_recover(failure, "binding_nested.txt", "out_nested.txt", "err_nested.txt")
  }
}
EOF

rm -f "${TEST_DIR}/binding_nested.txt" "${TEST_DIR}/out_nested.txt" "${TEST_DIR}/err_nested.txt"
e2e::run "nested_payload.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/out_nested.txt" "recover copied nested stdout capture"
e2e::assert_equals "$(<"${TEST_DIR}/out_nested.txt")" "$(printf 'outer start\nnested-stdout')" "stdout capture aggregates rule log + script stdout"
e2e::assert_equals "$(<"${TEST_DIR}/err_nested.txt")" "$(printf 'nested-stderr')" "sibling .err holds nested script stderr"
e2e::pass "nested rule+script failure: aggregated stdout capture + sibling .err"

# ===================================================================
# 3. CI-style failure payload (multi-line test output)
# ===================================================================
e2e::section "recover capture holds multi-line CI failure output"

e2e::file "ci_payload.jh" <<EOF
script npm_run_test_ci = \`\`\`
echo "FAIL src/app.test.ts"
echo "  Expected: 200"
echo "  Received: 500"
echo "Tests: 1 failed, 3 passed, 4 total" >&2
exit 1
\`\`\`

${CAPTURE_SCRIPT}

def ci_passes() {
  run npm_run_test_ci()
}

export def main() {
  run ci_passes() catch (failure) {
    run capture_recover(failure, "binding_ci.txt", "out_ci.txt", "err_ci.txt")
  }
}
EOF

rm -f "${TEST_DIR}/binding_ci.txt" "${TEST_DIR}/out_ci.txt" "${TEST_DIR}/err_ci.txt"
e2e::run "ci_payload.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/out_ci.txt" "recover copied CI stdout capture"
e2e::assert_equals "$(<"${TEST_DIR}/out_ci.txt")" "$(printf 'FAIL src/app.test.ts\n  Expected: 200\n  Received: 500')" "stdout capture matches CI stdout"
e2e::assert_equals "$(<"${TEST_DIR}/err_ci.txt")" "$(printf 'Tests: 1 failed, 3 passed, 4 total')" "sibling .err matches CI stderr"
e2e::pass "CI-style failure: multi-line stdout capture + sibling .err"

# ===================================================================
# 4. Recover runs once (single attempt, no retry loop)
# ===================================================================
e2e::section "recover runs exactly once on failure"

e2e::file "single_attempt.jh" <<EOF
script emit_attempt = \`\`\`
echo "attempt-output"
exit 1
\`\`\`

${CAPTURE_SCRIPT}

def check_rule() {
  run emit_attempt()
}

export def main() {
  run check_rule() catch (failure) {
    run capture_recover(failure, "binding_single.txt", "out_single.txt", "err_single.txt")
  }
}
EOF

rm -f "${TEST_DIR}/binding_single.txt" "${TEST_DIR}/out_single.txt" "${TEST_DIR}/err_single.txt"
e2e::run "single_attempt.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/out_single.txt" "recover copied the failed stdout capture"
e2e::assert_equals "$(<"${TEST_DIR}/out_single.txt")" "attempt-output" "stdout capture holds the failure output"
e2e::assert_equals "$(<"${TEST_DIR}/err_single.txt")" "" "sibling .err is empty when the script wrote no stderr"
e2e::pass "recover runs exactly once on failure"

# ===================================================================
# 5. No false payload on success
# ===================================================================
e2e::section "no catch payload when rule succeeds"

e2e::file "success_no_payload.jh" <<EOF
script say_ok = \`echo "all good"\`

${CAPTURE_SCRIPT}

def passes_first_try() {
  run say_ok()
}

export def main() {
  run passes_first_try() catch (failure) {
    run capture_recover(failure, "binding_false.txt", "out_false.txt", "err_false.txt")
  }
}
EOF

rm -f "${TEST_DIR}/binding_false.txt" "${TEST_DIR}/out_false.txt" "${TEST_DIR}/err_false.txt"
e2e::run "success_no_payload.jh" >/dev/null 2>&1

if [[ -f "${TEST_DIR}/binding_false.txt" ]]; then
  e2e::fail "recover block should NOT run when rule succeeds"
fi
e2e::pass "no false payload on success"
