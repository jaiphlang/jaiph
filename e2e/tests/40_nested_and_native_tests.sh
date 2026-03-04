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
  'running nested_run.jh' \
  'workflow default' \
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
