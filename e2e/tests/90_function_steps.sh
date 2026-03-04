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
  'running functions.jh' \
  'workflow default' \
  '└── function changed_files (<time>)' \
  '✓ PASS workflow default (<time>)')
expected_function="${expected_function%$'\n'}"
e2e::assert_output_equals "${function_out}" "${expected_function}" "run tree and PASS match expected"
