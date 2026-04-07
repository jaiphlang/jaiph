#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "cli_behavior"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "CLI version and unknown command behavior"

# When
version_out="$(jaiph --version)"

# Then
# assert_contains: version string includes dynamic version number and optional build metadata
e2e::assert_contains "${version_out}" "jaiph " "jaiph --version prints version banner"

# When
unknown_err_file="$(mktemp)"
unknown_out_file="$(mktemp)"
if jaiph definitely-not-a-command >"${unknown_out_file}" 2>"${unknown_err_file}"; then
  cat "${unknown_out_file}" >&2
  cat "${unknown_err_file}" >&2
  rm -f "${unknown_out_file}" "${unknown_err_file}"
  e2e::fail "unknown command should exit with non-zero status"
fi
unknown_err="$(cat "${unknown_err_file}")"
unknown_out="$(cat "${unknown_out_file}")"
rm -f "${unknown_out_file}" "${unknown_err_file}"

# Then
# assert_contains: error output includes dynamic usage text and available command list
e2e::assert_contains "${unknown_err}" "Unknown command: definitely-not-a-command" "unknown command includes command name"
# assert_contains: usage help text includes dynamic command list that may change across versions
e2e::assert_contains "${unknown_out}" "Usage:" "unknown command prints usage help"

e2e::section "CLI file extension guard for run"

# Given
e2e::file "not_a_workflow.txt" <<'EOF'
hello
EOF

# When
bad_ext_err_file="$(mktemp)"
if jaiph run "${TEST_DIR}/not_a_workflow.txt" 2>"${bad_ext_err_file}"; then
  cat "${bad_ext_err_file}" >&2
  rm -f "${bad_ext_err_file}"
  e2e::fail "jaiph run should reject non-.jh files"
fi
bad_ext_err="$(cat "${bad_ext_err_file}")"
rm -f "${bad_ext_err_file}"

# Then
# assert_contains: error message includes the absolute file path which varies per machine
e2e::assert_contains "${bad_ext_err}" "expects a single .jh file" "run rejects unsupported file extension"
