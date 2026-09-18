#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "ensure_recover_output_contract"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# catch/recover bind the failed step's stdout as an OUTPUT HANDLE (see Value
# types in docs/language.md): its bytes live on the failed step's stdout capture
# on disk. `stdin failure -> save()` STREAMS those bytes into the recover body's
# script (never argv, so a huge log cannot hit ARG_MAX); passing `failure` as an
# argv arg is a force site that SLURPS the same stdout contents. The binding is
# never a `.jaiph/runs/…/*.out` path. Each section streams the handle into a
# witness file and asserts its full contents.

# Shared helpers: `save` copies its stdin to $1; `record` copies its $1 (a force
# site — the slurped stdout contents) to $2.
HELPERS='script save = `cat > "$1"`
script record = `printf "%s" "$1" > "$2"`'

# ===================================================================
# 1. Simple script failure: stream the failed stdout; binding is contents
# ===================================================================
e2e::section "recover streams the failed stdout; the binding is contents, not a path"

e2e::file "simple_echo.jh" <<EOF
script simple_echo = \`\`\`
echo "Hello"
echo "Oops" >&2
exit 1
\`\`\`

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
# Force site (argv) slurps the stdout contents (trimmed); stream keeps the
# verbatim capture (with the trailing newline).
e2e::assert_equals "${binding}" "Hello" "argv force slurps the failed stdout contents"
e2e::assert_equals "$(<"${TEST_DIR}/out_simple.txt")" "$(printf 'Hello\n')" "stdin streams the failed stdout capture"
e2e::pass "simple script failure: streamed stdout + contents binding"

# ===================================================================
# 2. Nested rule + script failure: the failed step's stdout is the inner script
# ===================================================================
e2e::section "recover handle streams the innermost failing script's stdout"

e2e::file "nested_payload.jh" <<EOF
script failing_script = \`\`\`
echo "nested-stdout"
echo "nested-stderr" >&2
exit 1
\`\`\`

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

e2e::assert_file_exists "${TEST_DIR}/out_nested.txt" "recover streamed the failed stdout"
e2e::assert_equals "$(<"${TEST_DIR}/out_nested.txt")" "$(printf 'nested-stdout\n')" "handle streams the innermost failing script's stdout"
e2e::pass "nested rule+script failure: innermost stdout streamed"

# ===================================================================
# 3. CI-style failure payload (multi-line test output)
# ===================================================================
e2e::section "recover handle streams multi-line CI failure output"

e2e::file "ci_payload.jh" <<EOF
script npm_run_test_ci = \`\`\`
echo "FAIL src/app.test.ts"
echo "  Expected: 200"
echo "  Received: 500"
echo "Tests: 1 failed, 3 passed, 4 total" >&2
exit 1
\`\`\`

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

e2e::assert_file_exists "${TEST_DIR}/out_ci.txt" "recover streamed the CI stdout"
e2e::assert_equals "$(<"${TEST_DIR}/out_ci.txt")" "$(printf 'FAIL src/app.test.ts\n  Expected: 200\n  Received: 500\n')" "handle streams the full CI stdout"
e2e::pass "CI-style failure: multi-line stdout streamed"

# ===================================================================
# 4. Recover runs once (single attempt, no retry loop)
# ===================================================================
e2e::section "recover runs exactly once on failure"

e2e::file "single_attempt.jh" <<EOF
script emit_attempt = \`\`\`
echo "attempt-output"
exit 1
\`\`\`

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
script say_ok = \`echo "all good"\`

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
