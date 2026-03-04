#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "filesystem_side_effects"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Blackbox filesystem side effects"
# Given
cat > "${TEST_DIR}/fs_write_workflow.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  echo "abc" > workflow_wrote.txt
}
EOF
rm -f "${TEST_DIR}/workflow_wrote.txt"

# When
workflow_write_out="$(jaiph run "${TEST_DIR}/fs_write_workflow.jh")"

# Then: exact tree (shell-only workflow)
e2e::assert_file_exists "${TEST_DIR}/workflow_wrote.txt" "workflow shell step created workflow_wrote.txt"
e2e::assert_contains "$(cat "${TEST_DIR}/workflow_wrote.txt")" "abc" "workflow_wrote.txt has expected content"

expected_workflow_write=$(printf '%s\n' \
  'running fs_write_workflow.jh' \
  'workflow default' \
  '✓ PASS workflow default (<time>)')
expected_workflow_write="${expected_workflow_write%$'\n'}"
e2e::assert_output_equals "${workflow_write_out}" "${expected_workflow_write}" "workflow file write scenario passes"

# Given
cat > "${TEST_DIR}/fs_write_rule.jh" <<'EOF'
#!/usr/bin/env jaiph
rule write_attempt {
  echo "abc" > rule_wrote.txt
}

workflow default {
  ensure write_attempt
}
EOF
rm -f "${TEST_DIR}/rule_wrote.txt"
if e2e::readonly_sandbox_available; then
  # When
  rule_write_stderr="$(mktemp)"
  if jaiph run "${TEST_DIR}/fs_write_rule.jh" 2>"${rule_write_stderr}"; then
    cat "${rule_write_stderr}" >&2
    rm -f "${rule_write_stderr}"
    e2e::fail "rule write should be blocked when readonly sandbox is available"
  fi
  rm -f "${rule_write_stderr}"

  # Then
  if [[ -f "${TEST_DIR}/rule_wrote.txt" ]]; then
    e2e::fail "rule_wrote.txt should not exist when readonly sandbox blocks writes"
  fi
  e2e::pass "rule write is blocked in readonly sandbox"
else
  # When
  permissive_out="$(jaiph run "${TEST_DIR}/fs_write_rule.jh")"

  # Then: exact tree (ensure write_attempt)
  e2e::assert_file_exists "${TEST_DIR}/rule_wrote.txt" "fallback mode allows rule_wrote.txt creation"

  expected_permissive=$(printf '%s\n' \
    'running fs_write_rule.jh' \
    'workflow default' \
    '└── rule write_attempt (<time>)' \
    '✓ PASS workflow default (<time>)')
  expected_permissive="${expected_permissive%$'\n'}"
  e2e::assert_output_equals "${permissive_out}" "${expected_permissive}" "rule write runs in permissive fallback mode"
  e2e::skip "readonly sandbox not available on this host; write-blocking assertion skipped"
fi
