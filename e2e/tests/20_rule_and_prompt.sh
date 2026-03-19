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

# Then: step output in .out files only; stdout has tree and result
expected_rule_pass=$(printf '%s\n' \
  '' \
  'Jaiph: Running rule_pass.jh' \
  '' \
  'workflow default' \
  '  ▸ rule check_passes' \
  '  ✓ <time>' \
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
jaiph build "${TEST_DIR}/prompt_flow.jh"
prompt_ok_out="$(jaiph test "${TEST_DIR}/prompt_flow.test.jh")"

# Then
if [[ "${prompt_ok_out}" != *"passed"* ]] && [[ "${prompt_ok_out}" != *"PASS"* ]]; then
  printf "%s\n" "${prompt_ok_out}" >&2
  e2e::fail "prompt_flow.test.jh should pass"
fi
e2e::pass "prompt_flow.test.jh passes with inline mock"

# Run prompt workflow and assert tree has no embedded output (output only via log)
prompt_run_out="$(jaiph run "${TEST_DIR}/prompt_flow.jh")"
expected_prompt_run=$(printf '%s\n' \
  '' \
  'Jaiph: Running prompt_flow.jh' \
  '' \
  'workflow default' \
  '  ▸ prompt "e2e-prompt-please-return"' \
  '  ✓ <time>' \
  '✓ PASS workflow default (<time>)')
expected_prompt_run="${expected_prompt_run%$'\n'}"
e2e::assert_output_equals "${prompt_run_out}" "${expected_prompt_run}" "run prompt_flow.jh tree shows prompt line only, no output block"

# Prompt with variable references shows named params in tree (not positional args)
cat > "${TEST_DIR}/prompt_with_vars.jh" <<'EOF'
#!/usr/bin/env jaiph
local role = "engineer"
local task = "Fix bugs"
workflow default {
  prompt "$role does $task"
}
EOF
jaiph build "${TEST_DIR}/prompt_with_vars.jh"
prompt_vars_out="$(jaiph run "${TEST_DIR}/prompt_with_vars.jh")"
expected_prompt_vars=$(printf '%s\n' \
  '' \
  'Jaiph: Running prompt_with_vars.jh' \
  '' \
  'workflow default' \
  '  ▸ prompt "$role does $task" (role="engineer", task="Fix bugs")' \
  '  ✓ <time>' \
  '✓ PASS workflow default (<time>)')
expected_prompt_vars="${expected_prompt_vars%$'\n'}"
e2e::assert_output_equals "${prompt_vars_out}" "${expected_prompt_vars}" "prompt with var refs shows named params in tree"

# Prompt step .out file contains full agent transcript (mock run: workspace = TEST_DIR, so command is deterministic)
shopt -s nullglob
prompt_flow_run_dir=( "${TEST_DIR}/.jaiph/runs/"*/*prompt_flow.jh/ )
shopt -u nullglob
[[ ${#prompt_flow_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for prompt_flow.jh"
prompt_out_file=( "${prompt_flow_run_dir[0]}"*jaiph__prompt.out )
[[ ${#prompt_out_file[@]} -eq 1 ]] || e2e::fail "expected one .out file in run dir"
expected_prompt_out=$(printf '%s\n%s\n\n%s\n%s\n\n%s\n%s' \
  'Command:' \
  "cursor-agent --print --output-format stream-json --stream-partial-output --workspace ${TEST_DIR} --trust ${TEST_DIR} e2e-prompt-please-return-mock" \
  'Prompt:' \
  'e2e-prompt-please-return-mock' \
  'Final answer:' \
  'e2e-backend-no-mock-output')
e2e::assert_equals "$(<"${prompt_out_file[0]}")" "${expected_prompt_out}" "prompt_flow.jh agent .out file full content"

# Multi-line prompt is displayed as single line (newlines stripped from preview)
cat > "${TEST_DIR}/multiline_prompt.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  prompt "
    Line one and line two.
  "
  echo done
}
EOF
jaiph build "${TEST_DIR}/multiline_prompt.jh"
multiline_out="$(jaiph run "${TEST_DIR}/multiline_prompt.jh")"
expected_multiline=$(printf '%s\n' \
  '' \
  'Jaiph: Running multiline_prompt.jh' \
  '' \
  'workflow default' \
  '  ▸ prompt "Line one and line t"' \
  '  ✓ <time>' \
  '✓ PASS workflow default (<time>)')
expected_multiline="${expected_multiline%$'\n'}"
e2e::assert_output_equals "${multiline_out}" "${expected_multiline}" "multiline prompt tree shows step only, no output block"

# Multiline prompt step .out file contains full agent transcript (mock run: command deterministic)
shopt -s nullglob
multiline_run_dir=( "${TEST_DIR}/.jaiph/runs/"*/*multiline_prompt.jh/ )
shopt -u nullglob
[[ ${#multiline_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for multiline_prompt.jh"
multiline_out_file=( "${multiline_run_dir[0]}"*jaiph__prompt.out )
[[ ${#multiline_out_file[@]} -eq 1 ]] || e2e::fail "expected one .out file in run dir"
expected_multiline_out=$(printf '%s\n%s\n\n%s\n\n%s\n%s\n\n%s\n%s' \
  'Command:' \
  "cursor-agent --print --output-format stream-json --stream-partial-output --workspace ${TEST_DIR} --trust ${TEST_DIR} \$'\n    Line one and line two.\n  '" \
  'Prompt:' \
  '    Line one and line two.' \
  '  ' \
  'Final answer:' \
  'e2e-backend-no-mock-output')
e2e::assert_equals "$(<"${multiline_out_file[0]}")" "${expected_multiline_out}" "multiline_prompt.jh agent .out file full content"

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
