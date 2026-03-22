#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "filesystem_side_effects"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Blackbox filesystem side effects"

# Given
e2e::file "fs_write_workflow.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  echo "abc" > workflow_wrote.txt
}
EOF
rm -f "${TEST_DIR}/workflow_wrote.txt"

# When
workflow_write_out="$(e2e::run "fs_write_workflow.jh")"

# Then
e2e::assert_file_exists "${TEST_DIR}/workflow_wrote.txt" "workflow shell step created workflow_wrote.txt"
e2e::assert_contains "$(cat "${TEST_DIR}/workflow_wrote.txt")" "abc" "workflow_wrote.txt has expected content"

e2e::expect_stdout "${workflow_write_out}" <<'EOF'

Jaiph: Running fs_write_workflow.jh

workflow default
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "fs_write_workflow.jh" 0

# Given
e2e::file "fs_write_rule.jh" <<'EOF'
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
  if e2e::run "fs_write_rule.jh" 2>"${rule_write_stderr}"; then
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
  permissive_out="$(e2e::run "fs_write_rule.jh")"

  # Then
  e2e::assert_file_exists "${TEST_DIR}/rule_wrote.txt" "fallback mode allows rule_wrote.txt creation"

  e2e::expect_stdout "${permissive_out}" <<'EOF'

Jaiph: Running fs_write_rule.jh

workflow default
  ▸ rule write_attempt
  ✓ rule write_attempt (<time>)
✓ PASS workflow default (<time>)
EOF

  e2e::expect_out_files "fs_write_rule.jh" 0

  e2e::skip "readonly sandbox not available on this host; write-blocking assertion skipped"
fi
