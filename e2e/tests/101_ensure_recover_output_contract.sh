#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover_output_contract"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ===================================================================
# 1. Simple script failure through rule: stdout + stderr in catch binding
# ===================================================================
e2e::section "recover payload includes script stdout and stderr"

e2e::file "simple_echo.jh" <<'EOF'
script simple_echo = ```
echo "Hello"
echo "Oops" >&2
exit 1
```

script save_string_to_file = `printf '%s' "$1" > "$2"`

rule simple_echo_rule() {
  run simple_echo()
}

workflow default() {
  ensure simple_echo_rule() catch (failure) {
    run save_string_to_file(failure, "recover_simple.txt")
  }
}
EOF

rm -f "${TEST_DIR}/recover_simple.txt"
e2e::run "simple_echo.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/recover_simple.txt" "recover wrote payload file"
witness="$(<"${TEST_DIR}/recover_simple.txt")"
expected_witness="$(printf 'Hello\nOops')"
e2e::assert_equals "${witness}" "${expected_witness}" "recover binding contains script stdout+stderr"
e2e::pass "simple script failure: stdout + stderr in catch payload"

# ===================================================================
# 2. Nested rule + script failure aggregation
# ===================================================================
e2e::section "recover payload aggregates nested rule log + script output"

e2e::file "nested_payload.jh" <<'EOF'
script failing_script = ```
echo "nested-stdout"
echo "nested-stderr" >&2
exit 1
```

script save_string_to_file = `printf '%s' "$1" > "$2"`

rule inner() {
  run failing_script()
}

rule outer() {
  log "outer start"
  ensure inner()
}

workflow default() {
  ensure outer() catch (failure) {
    run save_string_to_file(failure, "recover_nested.log")
  }
}
EOF

rm -f "${TEST_DIR}/recover_nested.log"
e2e::run "nested_payload.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/recover_nested.log" "recover wrote nested payload"
witness="$(<"${TEST_DIR}/recover_nested.log")"
expected_witness="$(printf 'outer start\nnested-stdout\nnested-stderr')"
e2e::assert_equals "${witness}" "${expected_witness}" "recover binding aggregates rule log + script stdout + stderr"
e2e::pass "nested rule+script failure: aggregated payload in recover"

# ===================================================================
# 3. CI-style failure payload (multi-line test output)
# ===================================================================
e2e::section "recover payload captures multi-line CI failure output"

e2e::file "ci_payload.jh" <<'EOF'
script npm_run_test_ci = ```
echo "FAIL src/app.test.ts"
echo "  Expected: 200"
echo "  Received: 500"
echo "Tests: 1 failed, 3 passed, 4 total" >&2
exit 1
```

script save_string_to_file = `printf '%s' "$1" > "$2"`

rule ci_passes() {
  run npm_run_test_ci()
}

workflow default() {
  ensure ci_passes() catch (failure) {
    run save_string_to_file(failure, "ci_failure.log")
  }
}
EOF

rm -f "${TEST_DIR}/ci_failure.log"
e2e::run "ci_payload.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/ci_failure.log" "recover wrote CI failure payload"
witness="$(<"${TEST_DIR}/ci_failure.log")"
expected_witness="$(printf 'FAIL src/app.test.ts\n  Expected: 200\n  Received: 500\nTests: 1 failed, 3 passed, 4 total')"
e2e::assert_equals "${witness}" "${expected_witness}" "CI failure payload matches full expected content"
e2e::pass "CI-style failure: multi-line payload captured"

# ===================================================================
# 4. Recover runs once (single attempt, no retry loop)
# ===================================================================
e2e::section "recover runs exactly once on failure"

e2e::file "single_attempt.jh" <<'EOF'
script emit_attempt = ```
echo "attempt-output"
exit 1
```

script save_string_to_file = `printf '%s' "$1" > "$2"`

rule check_rule() {
  run emit_attempt()
}

workflow default() {
  ensure check_rule() catch (failure) {
    run save_string_to_file(failure, "payload_single.txt")
  }
}
EOF

rm -f "${TEST_DIR}/payload_single.txt"
e2e::run "single_attempt.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/payload_single.txt" "recover payload written"
payload="$(<"${TEST_DIR}/payload_single.txt")"
e2e::assert_equals "${payload}" "attempt-output" "recover gets failure output"
e2e::pass "recover runs exactly once on failure"

# ===================================================================
# 5. No false payload on success
# ===================================================================
e2e::section "no catch payload when rule succeeds"

e2e::file "success_no_payload.jh" <<'EOF'
script say_ok = `echo "all good"`

script save_string_to_file = `printf '%s' "$1" > "$2"`

rule passes_first_try() {
  run say_ok()
}

workflow default() {
  ensure passes_first_try() catch (failure) {
    run save_string_to_file(failure, "false_payload.txt")
  }
}
EOF

rm -f "${TEST_DIR}/false_payload.txt"
e2e::run "success_no_payload.jh" >/dev/null 2>&1

if [[ -f "${TEST_DIR}/false_payload.txt" ]]; then
  e2e::fail "recover block should NOT run when rule succeeds"
fi
e2e::pass "no false payload on success"
