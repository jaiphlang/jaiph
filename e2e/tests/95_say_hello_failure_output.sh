#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "say_hello_failure_output"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "say_hello.test.jh exact failing output"

# Given
cp "${ROOT_DIR}/e2e/say_hello.jh" "${TEST_DIR}/say_hello.jh"
cp "${ROOT_DIR}/e2e/say_hello.test.jh" "${TEST_DIR}/say_hello.test.jh"

# When
set +e
say_hello_out="$(jaiph test "${TEST_DIR}/say_hello.test.jh" 2>&1)"
say_hello_exit=$?
set -e

# Then
if [[ ${say_hello_exit} -eq 0 ]]; then
  printf "%s\n" "${say_hello_out}" >&2
  e2e::fail "say_hello.test.jh should fail intentionally"
fi

expected_say_hello_out=$(printf '%s\n' \
  'testing say_hello.test.jh' \
  '  ▸ without name, workflow fails with validation message' \
  '  ✗ expectEqual failed: <time>' \
  "    - You didn't provide your name" \
  '    + You didn'"'"'t provide your name :(' \
  '' \
  '  ▸ with name, returns greeting and logs response' \
  '  ✓ <time>' \
  '' \
  '✗ 1 / 2 test(s) failed' \
  '  - without name, workflow fails with validation message')
expected_say_hello_out="${expected_say_hello_out%$'\n'}"

e2e::assert_output_equals "${say_hello_out}" "${expected_say_hello_out}" "say_hello.test.jh failing output matches exactly"
