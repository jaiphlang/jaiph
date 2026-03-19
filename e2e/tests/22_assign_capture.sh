#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "assign_capture"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Assignment capture for ensure and shell"
cp "${ROOT_DIR}/e2e/assign_capture.jh" "${TEST_DIR}/assign_capture.jh"
jaiph build "${TEST_DIR}/assign_capture.jh"
assign_out="$(jaiph run "${TEST_DIR}/assign_capture.jh")"

# Run succeeds (assignment capture does not change exit behavior)
if [[ "${assign_out}" != *"PASS"* ]]; then
  printf "%s\n" "${assign_out}" >&2
  e2e::fail "assign_capture.jh should pass"
fi
e2e::pass "assign_capture.jh passes with response = ensure and out = echo"

# Full tree output for assign capture workflow
expected_assign=$(printf '%s\n' \
  '' \
  'Jaiph: Running assign_capture.jh' \
  '' \
  'workflow default' \
  '✓ PASS workflow default (<time>)')
expected_assign="${expected_assign%$'\n'}"
e2e::assert_output_equals "${assign_out}" "${expected_assign}" "assign capture tree output"
