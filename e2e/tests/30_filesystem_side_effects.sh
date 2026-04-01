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
script write_workflow_file = ```
echo "abc" > workflow_wrote.txt
```
workflow default {
  run write_workflow_file()
}
EOF
rm -f "${TEST_DIR}/workflow_wrote.txt"

# When
workflow_write_out="$(e2e::run "fs_write_workflow.jh")"

# Then
e2e::assert_file_exists "${TEST_DIR}/workflow_wrote.txt" "workflow shell step created workflow_wrote.txt"
e2e::assert_equals "$(cat "${TEST_DIR}/workflow_wrote.txt")" "abc" "workflow_wrote.txt has expected content"

e2e::expect_stdout "${workflow_write_out}" <<'EOF'

Jaiph: Running fs_write_workflow.jh

workflow default
  ▸ script write_workflow_file
  ✓ script write_workflow_file (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "fs_write_workflow.jh" 2

# Given
e2e::file "fs_write_rule.jh" <<'EOF'
#!/usr/bin/env jaiph
script write_attempt_impl = ```
echo "abc" > rule_wrote.txt
```
rule write_attempt {
  run write_attempt_impl()
}

workflow default {
  ensure write_attempt()
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
  ·   ▸ script write_attempt_impl
  ·   ✓ script write_attempt_impl (<time>)
  ✓ rule write_attempt (<time>)
✓ PASS workflow default (<time>)
EOF

  e2e::expect_out_files "fs_write_rule.jh" 3

  e2e::skip "readonly sandbox not available on this host; write-blocking assertion skipped"
fi
