#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "rule_and_prompt"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Rules, ensure, and prompt test behavior"
E2E_MOCK_BIN="${ROOT_DIR}/e2e/bin"
chmod 755 "${E2E_MOCK_BIN}/mock_ok" "${E2E_MOCK_BIN}/mock_fail" "${E2E_MOCK_BIN}/cursor-agent"
export PATH="${E2E_MOCK_BIN}:${PATH}"

# Given
cat > "${TEST_DIR}/rule_pass.jh" <<'EOF'
#!/usr/bin/env jaiph
rule check_passes {
  mock_ok
}
workflow default {
  ensure check_passes
  echo "e2e-rule-pass-done"
}
EOF

# When
jaiph build "${TEST_DIR}/rule_pass.jh"
rule_pass_out="$(jaiph run "${TEST_DIR}/rule_pass.jh")"

# Then: exact tree (ensure check_passes)
expected_rule_pass=$(printf '%s\n' \
  '' \
  'running rule_pass.jh' \
  '' \
  'workflow default' \
  '  ▸ rule check_passes' \
  '  ✓ <time>' \
  'e2e-rule-pass-done' \
  '✓ PASS workflow default (<time>)')
expected_rule_pass="${expected_rule_pass%$'\n'}"
e2e::assert_output_equals "${rule_pass_out}" "${expected_rule_pass}" "rule_pass.jh passes"

# Given
cat > "${TEST_DIR}/rule_fail.jh" <<'EOF'
#!/usr/bin/env jaiph
rule check_fails {
  mock_fail
}
workflow default {
  ensure check_fails
  echo "unreachable"
}
EOF

# When
jaiph build "${TEST_DIR}/rule_fail.jh"
rule_fail_stderr="$(mktemp)"
if jaiph run "${TEST_DIR}/rule_fail.jh" 2>"${rule_fail_stderr}"; then
  cat "${rule_fail_stderr}" >&2
  rm -f "${rule_fail_stderr}"
  e2e::fail "rule_fail.jh should fail"
fi
rule_fail_err="$(cat "${rule_fail_stderr}")"
rm -f "${rule_fail_stderr}"

# Then
e2e::assert_contains "${rule_fail_err}" "e2e-rule-fail-message" "rule_fail.jh emits expected stderr"

# Given
cat > "${TEST_DIR}/ensure_fail.jh" <<'EOF'
#!/usr/bin/env jaiph
rule step_ok {
  mock_ok
}
rule step_fail {
  mock_fail
}
workflow default {
  ensure step_ok
  ensure step_fail
}
EOF

# When
jaiph build "${TEST_DIR}/ensure_fail.jh"
ensure_fail_stderr="$(mktemp)"
if jaiph run "${TEST_DIR}/ensure_fail.jh" 2>"${ensure_fail_stderr}"; then
  cat "${ensure_fail_stderr}" >&2
  rm -f "${ensure_fail_stderr}"
  e2e::fail "ensure_fail.jh should fail"
fi
ensure_fail_err="$(cat "${ensure_fail_stderr}")"
rm -f "${ensure_fail_stderr}"

# Then
e2e::assert_contains "${ensure_fail_err}" "e2e-rule-fail-message" "ensure failure emits expected stderr"

# Given
cat > "${TEST_DIR}/prompt_flow.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  prompt "e2e-prompt-please-return-mock"
}
EOF
cat > "${TEST_DIR}/prompt_flow.test.jh" <<'EOF'
#!/usr/bin/env jaiph
import "prompt_flow.jh" as p

test "prompt returns mock response" {
  mock prompt "e2e-prompt-mock-response"
  response = p.default
  expectContain response "e2e-prompt-mock-response"
}
EOF

# When
prompt_ok_out="$(jaiph test "${TEST_DIR}/prompt_flow.test.jh")"

# Then
if [[ "${prompt_ok_out}" != *"passed"* ]] && [[ "${prompt_ok_out}" != *"PASS"* ]]; then
  printf "%s\n" "${prompt_ok_out}" >&2
  e2e::fail "prompt_flow.test.jh should pass"
fi
e2e::pass "prompt_flow.test.jh passes with inline mock"

# Given: workflow with prompt but test does not mock it -> selected backend runs (cursor by default).
cat > "${TEST_DIR}/prompt_unmatched.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  result = prompt "e2e-unmatched-prompt-never-mocked"
  printf '%s' "$result"
}
EOF
cat > "${TEST_DIR}/prompt_unmatched.test.jh" <<'EOF'
#!/usr/bin/env jaiph
import "prompt_unmatched.jh" as p

test "when no mock, backend runs" {
  response = p.default
  expectContain response "e2e-backend-no-mock-output"
}
EOF

# When (cursor-agent is in PATH via E2E_MOCK_BIN)
prompt_unmatched_out="$(jaiph test "${TEST_DIR}/prompt_unmatched.test.jh" 2>&1)"

# Then
if [[ "${prompt_unmatched_out}" != *"passed"* ]] && [[ "${prompt_unmatched_out}" != *"PASS"* ]]; then
  printf "%s\n" "${prompt_unmatched_out}" >&2
  e2e::fail "prompt_unmatched.test.jh should pass when backend (cursor-agent) is in PATH"
fi
e2e::pass "prompt_unmatched.test.jh passes when backend (cursor-agent) is in PATH"
