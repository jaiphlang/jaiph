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

# Assert .out file content for assign_capture.jh
shopt -s nullglob
assign_run_dir=( "${TEST_DIR}/.jaiph/runs/"*/*assign_capture.jh/ )
shopt -u nullglob
[[ ${#assign_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for assign_capture.jh"
assign_out_files=( "${assign_run_dir[0]}"*.out )
[[ ${#assign_out_files[@]} -eq 1 ]] || e2e::fail "expected one .out file for assign_capture.jh, got ${#assign_out_files[@]}"
expected_assign_out=$(printf '%s\n%s' \
  'response=captured-stdout' \
  'out=shell-capture')
e2e::assert_equals "$(<"${assign_out_files[0]}")" "${expected_assign_out}" "assign_capture.jh default workflow .out content"
