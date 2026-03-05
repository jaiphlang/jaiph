#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "function_steps"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "function calls in workflow tree and side effects"
# Given
cat > "${TEST_DIR}/functions.jh" <<'EOF'
function changed_files() {
  echo "fn-called" > function_called.txt
}

workflow default {
  changed_files
}
EOF
rm -f "${TEST_DIR}/function_called.txt"

# When
function_out="$(jaiph run "${TEST_DIR}/functions.jh")"

# Then: exact tree (function step) and side effect
e2e::assert_file_exists "${TEST_DIR}/function_called.txt" "function step command executed and changed filesystem"

expected_function=$(printf '%s\n' \
  '' \
  'running functions.jh' \
  '' \
  'workflow default' \
  '└── function changed_files (<time>)' \
  '✓ PASS workflow default (<time>)')
expected_function="${expected_function%$'\n'}"
e2e::assert_output_equals "${function_out}" "${expected_function}" "run tree and PASS match expected"

e2e::section "run, ensure, and function argument forwarding"
# Given
cat > "${TEST_DIR}/args_forwarding.jh" <<'EOF'
rule expect_args {
  test "$1" = "one"
  test "$2" = "two words"
}

function write_args() {
  printf "%s|%s\n" "$1" "$2" > function_args.txt
}

workflow called {
  ensure expect_args "$1" "$2"
  write_args "$1" "$2"
  printf "%s|%s\n" "$1" "$2" > workflow_args.txt
}

workflow default {
  run called "one" "two words"
}
EOF
rm -f "${TEST_DIR}/function_args.txt" "${TEST_DIR}/workflow_args.txt"

# When
args_out="$(jaiph run "${TEST_DIR}/args_forwarding.jh" 2>&1)"

# Then
e2e::assert_file_exists "${TEST_DIR}/function_args.txt" "function received forwarded arguments"
e2e::assert_file_exists "${TEST_DIR}/workflow_args.txt" "workflow received arguments from run"
e2e::assert_equals "$(tr -d '\r\n' < "${TEST_DIR}/function_args.txt")" "one|two words" "function args exact match"
e2e::assert_equals "$(tr -d '\r\n' < "${TEST_DIR}/workflow_args.txt")" "one|two words" "workflow args exact match"
e2e::assert_contains "${args_out}" "rule expect_args" "ensure with args executed in called workflow"
e2e::assert_contains "${args_out}" "workflow called" "run with args executed target workflow"
e2e::pass "run, ensure, and function all support argument forwarding"
