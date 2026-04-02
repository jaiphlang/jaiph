#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "examples"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"
EXAMPLES_DIR="${ROOT_DIR}/examples"

# Copy all example files into the test directory so e2e helpers work.
cp "${EXAMPLES_DIR}"/*.jh "${TEST_DIR}/"
cp "${EXAMPLES_DIR}"/*.test.jh "${TEST_DIR}/"

# ── agent_inbox.jh ──────────────────────────────────────────────────────────

e2e::section "examples/agent_inbox.jh — full run (no prompts)"

# When
inbox_out="$(e2e::run "agent_inbox.jh")"

# Then
# assert_contains: CLI progress tree includes dispatch timing and indentation that varies
e2e::assert_contains "${inbox_out}" "workflow default" "agent_inbox: workflow ran"
e2e::assert_contains "${inbox_out}" "workflow scanner" "agent_inbox: scanner dispatch visible"
e2e::assert_contains "${inbox_out}" "workflow analyst" "agent_inbox: analyst dispatch visible"
e2e::assert_contains "${inbox_out}" "workflow reviewer" "agent_inbox: reviewer dispatch visible"
e2e::assert_contains "${inbox_out}" "✓ PASS workflow default" "agent_inbox: workflow succeeds"

# ── say_hello.jh failure path ────────────────────────────────────────────────

e2e::section "examples/say_hello.jh — failure without name argument"

# When
set +e
say_hello_out="$(e2e::run "say_hello.jh" 2>&1)"
say_hello_exit=$?
set -e

# Then
if [[ ${say_hello_exit} -eq 0 ]]; then
  e2e::fail "say_hello.jh without args should fail"
fi
# assert_contains: output includes paths and timing that vary across runs
e2e::assert_contains "${say_hello_out}" "You didn't provide your name" "say_hello: failure message present"

# ── say_hello.test.jh ───────────────────────────────────────────────────────

e2e::section "examples/say_hello.test.jh — native test execution"

# When
set +e
test_out="$(jaiph test "${TEST_DIR}/say_hello.test.jh" 2>&1)"
test_exit=$?
set -e

# Then — both tests pass
if [[ ${test_exit} -ne 0 ]]; then
  printf "%s\n" "${test_out}" >&2
  e2e::fail "say_hello.test.jh should pass both tests"
fi

e2e::expect_stdout "${test_out}" <<'EOF'
testing say_hello.test.jh
  ▸ without name, workflow fails with validation message
  ✓ <time>

  ▸ with name, returns greeting and logs response
  ✓ <time>

✓ 2 / 2 test(s) passed
EOF

# ── ensure_ci_passes.test.jh ────────────────────────────────────────────────

e2e::section "examples/ensure_ci_passes.test.jh — native test with mocked script"

# When
ci_test_out="$(jaiph test "${TEST_DIR}/ensure_ci_passes.test.jh" 2>&1)"

# Then
e2e::expect_stdout "${ci_test_out}" <<'EOF'
testing ensure_ci_passes.test.jh
  ▸ ci passes on first attempt skips recover
  ✓ <time>
✓ 1 test(s) passed
EOF
