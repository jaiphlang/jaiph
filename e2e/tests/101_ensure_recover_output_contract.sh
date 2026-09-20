#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover_output_contract"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# catch/recover bind the failed step's stdout THEN stderr, merged into one
# OUTPUT HANDLE (see Value types / catch-and-recover in docs/language.md): the
# bytes live in one on-disk capture. `stdin failure -> save()` STREAMS those
# bytes into the recover body's script (never argv, so a huge log cannot hit
# ARG_MAX); passing `failure` as an argv arg is a force site that SLURPS the same
# merged contents (trimmed). The binding is never a `.jaiph/runs/…/*.out` path.
# Each section streams the handle into a witness file and asserts its full
# contents. A stderr-only failure still yields a non-empty handle without 2>&1.

# Shared helpers: `save` copies its stdin to $1; `record` copies its $1 (a force
# site — the slurped stdout contents) to $2.
HELPERS=$(cat <<'JH'
script save = 'cat > "$1"'
script record = '''
printf "%s" "$1" > "$2"
'''
JH
)

# ===================================================================
# 1. Simple script failure: stream the failed stdout; binding is contents
# ===================================================================
e2e::section "recover streams the failed stdout then stderr; the binding is contents, not a path"

e2e::file "simple_echo.jh" <<EOF
script simple_echo = '''
echo "Hello"
echo "Oops" >&2
exit 1
'''

${HELPERS}

def simple_echo_rule() {
  simple_echo()
}

export def main() {
  simple_echo_rule() catch (failure) {
    stdin failure -> save("out_simple.txt")
    record(failure, "binding_simple.txt")
  }
}
EOF

rm -f "${TEST_DIR}/binding_simple.txt" "${TEST_DIR}/out_simple.txt"
e2e::run "simple_echo.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/binding_simple.txt" "recover ran and recorded the binding"
binding="$(<"${TEST_DIR}/binding_simple.txt")"
case "${binding}" in
  *.jaiph/runs/*.out) e2e::fail "binding must be contents, never a run-dir capture path: ${binding}" ;;
esac
# Force site (argv) slurps the merged stdout+stderr contents (trimmed); stream
# keeps the verbatim merged capture (stdout bytes then stderr bytes).
e2e::assert_equals "${binding}" "$(printf 'Hello\nOops')" "argv force slurps the merged stdout+stderr contents"
e2e::assert_equals "$(<"${TEST_DIR}/out_simple.txt")" "$(printf 'Hello\nOops\n')" "stdin streams the merged stdout+stderr capture"
e2e::pass "simple script failure: streamed stdout+stderr + contents binding"

# ===================================================================
# 2. Nested rule + script failure: the failed step's stdout is the inner script
# ===================================================================
e2e::section "recover handle streams the innermost failing script's stdout then stderr"

e2e::file "nested_payload.jh" <<EOF
script failing_script = '''
echo "nested-stdout"
echo "nested-stderr" >&2
exit 1
'''

${HELPERS}

def inner() {
  failing_script()
}

def outer() {
  log "outer start"
  inner()
}

export def main() {
  outer() catch (failure) {
    stdin failure -> save("out_nested.txt")
  }
}
EOF

rm -f "${TEST_DIR}/out_nested.txt"
e2e::run "nested_payload.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/out_nested.txt" "recover streamed the failed stdout+stderr"
e2e::assert_equals "$(<"${TEST_DIR}/out_nested.txt")" "$(printf 'nested-stdout\nnested-stderr\n')" "handle streams the innermost failing script's stdout then stderr"
e2e::pass "nested rule+script failure: innermost stdout+stderr streamed"

# ===================================================================
# 3. CI-style failure payload (multi-line test output)
# ===================================================================
e2e::section "recover handle streams multi-line CI failure output"

e2e::file "ci_payload.jh" <<EOF
script npm_run_test_ci = '''
echo "FAIL src/app.test.ts"
echo "  Expected: 200"
echo "  Received: 500"
echo "Tests: 1 failed, 3 passed, 4 total" >&2
exit 1
'''

${HELPERS}

def ci_passes() {
  npm_run_test_ci()
}

export def main() {
  ci_passes() catch (failure) {
    stdin failure -> save("out_ci.txt")
  }
}
EOF

rm -f "${TEST_DIR}/out_ci.txt"
e2e::run "ci_payload.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/out_ci.txt" "recover streamed the CI stdout+stderr"
e2e::assert_equals "$(<"${TEST_DIR}/out_ci.txt")" "$(printf 'FAIL src/app.test.ts\n  Expected: 200\n  Received: 500\nTests: 1 failed, 3 passed, 4 total\n')" "handle streams the full CI stdout then stderr"
e2e::pass "CI-style failure: multi-line stdout+stderr streamed"

# ===================================================================
# 4. Recover runs once (single attempt, no retry loop)
# ===================================================================
e2e::section "recover runs exactly once on failure"

e2e::file "single_attempt.jh" <<EOF
script emit_attempt = '''
echo "attempt-output"
exit 1
'''

${HELPERS}

def check_rule() {
  emit_attempt()
}

export def main() {
  check_rule() catch (failure) {
    stdin failure -> save("out_single.txt")
  }
}
EOF

rm -f "${TEST_DIR}/out_single.txt"
e2e::run "single_attempt.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/out_single.txt" "recover streamed the failed stdout"
e2e::assert_equals "$(<"${TEST_DIR}/out_single.txt")" "$(printf 'attempt-output\n')" "handle streams the failure stdout"
e2e::pass "recover runs exactly once on failure"

# ===================================================================
# 5. No false payload on success
# ===================================================================
e2e::section "no catch payload when rule succeeds"

e2e::file "success_no_payload.jh" <<EOF
script say_ok = 'echo "all good"'

${HELPERS}

def passes_first_try() {
  say_ok()
}

export def main() {
  passes_first_try() catch (failure) {
    stdin failure -> save("out_false.txt")
  }
}
EOF

rm -f "${TEST_DIR}/out_false.txt"
e2e::run "success_no_payload.jh" >/dev/null 2>&1

if [[ -f "${TEST_DIR}/out_false.txt" ]]; then
  e2e::fail "recover block should NOT run when rule succeeds"
fi
e2e::pass "no false payload on success"

# ===================================================================
# 6. Stderr-only failure: the handle is the stderr text (no 2>&1 needed)
# ===================================================================
e2e::section "recover sees stderr even when the producer never redirected 2>&1"

e2e::file "stderr_only.jh" <<EOF
script stderr_only = '''
echo "boom" >&2
exit 1
'''

${HELPERS}

def stderr_only_rule() {
  stderr_only()
}

export def main() {
  stderr_only_rule() catch (failure) {
    stdin failure -> save("out_stderr.txt")
    record(failure, "binding_stderr.txt")
  }
}
EOF

rm -f "${TEST_DIR}/binding_stderr.txt" "${TEST_DIR}/out_stderr.txt"
e2e::run "stderr_only.jh" >/dev/null 2>&1 || true

e2e::assert_file_exists "${TEST_DIR}/binding_stderr.txt" "recover ran on a stderr-only failure"
# Empty stdout + non-empty stderr still yields a non-empty handle.
e2e::assert_equals "$(<"${TEST_DIR}/binding_stderr.txt")" "boom" "argv force slurps the stderr text (trimmed like a stdout handle)"
e2e::assert_equals "$(<"${TEST_DIR}/out_stderr.txt")" "$(printf 'boom\n')" "stdin streams the stderr bytes"
e2e::pass "stderr-only failure: recover is usable without 2>&1"

# ===================================================================
# 7. Success regression: a successful call's handle stays stdout only
# ===================================================================
e2e::section "success handle stays stdout only (const and stdin producer)"

e2e::file "success_stdout_only.jh" <<EOF
script ok_noise = '''
echo "ok"
echo "noise" >&2
'''

${HELPERS}

export def main() {
  const x = ok_noise()
  record(x, "const_ok.txt")
  stdin ok_noise() -> save("stdin_ok.txt")
}
EOF

rm -f "${TEST_DIR}/const_ok.txt" "${TEST_DIR}/stdin_ok.txt"
e2e::run "success_stdout_only.jh" >/dev/null 2>&1

e2e::assert_file_exists "${TEST_DIR}/const_ok.txt" "const captured the successful stdout"
e2e::assert_equals "$(<"${TEST_DIR}/const_ok.txt")" "ok" "const x = foo() forces stdout only, no stderr noise"
e2e::assert_equals "$(<"${TEST_DIR}/stdin_ok.txt")" "$(printf 'ok\n')" "stdin foo() -> sink() streams stdout only on success"
e2e::pass "success regression: handle stays stdout only"
