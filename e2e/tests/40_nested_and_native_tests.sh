#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "nested_and_native_tests"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Output tree and nested workflow visibility"
# Given
cat > "${TEST_DIR}/nested_inner.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  echo "e2e-nested-inner"
}
EOF
cat > "${TEST_DIR}/nested_run.jh" <<'EOF'
#!/usr/bin/env jaiph
import "nested_inner.jh" as inner
workflow default {
  run inner.default
  echo "e2e-nested-outer"
}
EOF

# When
nested_out="$(jaiph run "${TEST_DIR}/nested_run.jh")"

# Then: exact tree (nested workflow row may be omitted in non-TTY; assert minimal tree)
expected_nested_out=$(printf '%s\n' \
  '' \
  'running nested_run.jh' \
  '' \
  'workflow default' \
  'e2e-nested-inner' \
  'e2e-nested-outer' \
  '✓ PASS workflow default (<time>)')
expected_nested_out="${expected_nested_out%$'\n'}"
normalized_nested="$(e2e::normalize_output "${nested_out}")"
e2e::assert_equals "${normalized_nested}" "${expected_nested_out}" "nested run output matches expected tree"

e2e::section "Native *.test.jh flow"
# Given
cat > "${TEST_DIR}/workflow_greeting.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  prompt "e2e-greeting-prompt"
  echo "done"
}
EOF
cat > "${TEST_DIR}/workflow_greeting.test.jh" <<'EOF'
#!/usr/bin/env jaiph
import "workflow_greeting.jh" as w

test "runs happy path and prints PASS" {
  # Given
  mock prompt "e2e-greeting-mock"

  # When
  response = w.default

  # Then
  expectContain response "e2e-greeting-mock"
  expectContain response "done"
}
EOF

# When
native_test_out="$(jaiph test "${TEST_DIR}/workflow_greeting.test.jh")"

# Then
if [[ "${native_test_out}" != *"passed"* ]] && [[ "${native_test_out}" != *"PASS"* ]]; then
  printf "%s\n" "${native_test_out}" >&2
  e2e::fail "workflow_greeting.test.jh should pass"
fi
e2e::pass "workflow_greeting.test.jh passes"

e2e::section "Mock prompt block with no else: unmatched prompt fails with clear message"
# Given: workflow prompts with string that mock block does not match
cat > "${TEST_DIR}/unmatched_mock_block.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  result = prompt "e2e-unmatched-prompt-never-mocked"
  printf '%s' "$result"
}
EOF
cat > "${TEST_DIR}/unmatched_mock_block.test.jh" <<'EOF'
#!/usr/bin/env jaiph
import "unmatched_mock_block.jh" as p

test "unmatched prompt never mocked" {
  mock prompt {
    if $1 contains "other" ; then
      respond "x"
    fi
  }
  response = p.default
  expectContain response "x"
}
EOF

# When: run test (expect failure)
set +e
if [[ -f "${ROOT_DIR}/dist/src/jaiph_stdlib.sh" ]]; then
  export JAIPH_STDLIB="${ROOT_DIR}/dist/src/jaiph_stdlib.sh"
fi
unmatched_out="$(jaiph test "${TEST_DIR}/unmatched_mock_block.test.jh" 2>&1)"
unmatched_exit=$?
set -e

# Then: exit 1 and stderr reports failed workflow execution
if [[ $unmatched_exit -eq 0 ]]; then
  printf "%s\n" "${unmatched_out}" >&2
  e2e::fail "unmatched_mock_block.test.jh should exit 1 when no branch matches"
fi
# Either explicit workflow failure message or expectContain failed (empty output) indicates correct behavior
if [[ "${unmatched_out}" != *"workflow exited with status"* ]] && [[ "${unmatched_out}" != *"expectContain failed"*"0 chars"* ]]; then
  printf "%s\n" "${unmatched_out}" >&2
  e2e::fail "unmatched prompt should report workflow failure or expectContain failure"
fi
e2e::pass "mock prompt block without else fails when prompt never matched"
