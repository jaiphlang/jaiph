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
e2e::file "rule_pass.jh" <<'EOF'
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
rule_pass_out="$(e2e::run "rule_pass.jh")"

# Then
e2e::expect_stdout "${rule_pass_out}" <<'EOF'

Jaiph: Running rule_pass.jh

workflow default
  ▸ rule check_passes
  ✓ rule check_passes (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "rule_pass.jh" 1
e2e::expect_out "rule_pass.jh" "default" "e2e-rule-pass-done"

# Given
e2e::file "rule_fail.jh" <<'EOF'
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
rule_fail_stderr="$(mktemp)"
if e2e::run "rule_fail.jh" 2>"${rule_fail_stderr}"; then
  cat "${rule_fail_stderr}" >&2
  rm -f "${rule_fail_stderr}"
  e2e::fail "rule_fail.jh should fail"
fi
rule_fail_err="$(cat "${rule_fail_stderr}")"
rm -f "${rule_fail_stderr}"

# Then
e2e::assert_contains "${rule_fail_err}" "e2e-rule-fail-message" "rule_fail.jh emits expected stderr"

# Given
e2e::file "ensure_fail.jh" <<'EOF'
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
ensure_fail_stderr="$(mktemp)"
if e2e::run "ensure_fail.jh" 2>"${ensure_fail_stderr}"; then
  cat "${ensure_fail_stderr}" >&2
  rm -f "${ensure_fail_stderr}"
  e2e::fail "ensure_fail.jh should fail"
fi
ensure_fail_err="$(cat "${ensure_fail_stderr}")"
rm -f "${ensure_fail_stderr}"

# Then
e2e::assert_contains "${ensure_fail_err}" "e2e-rule-fail-message" "ensure failure emits expected stderr"

# Given
e2e::file "prompt_flow.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  prompt "e2e-prompt-please-return-mock"
}
EOF

e2e::file "prompt_flow.test.jh" <<'EOF'
#!/usr/bin/env jaiph
import "prompt_flow.jh" as p

test "prompt returns mock response" {
  mock prompt "e2e-prompt-mock-response"
  response = p.default
  expectContain response "e2e-prompt-mock-response"
}
EOF

# When
jaiph build "${TEST_DIR}/prompt_flow.jh" >/dev/null
prompt_ok_out="$(jaiph test "${TEST_DIR}/prompt_flow.test.jh")"

# Then
if [[ "${prompt_ok_out}" != *"passed"* ]] && [[ "${prompt_ok_out}" != *"PASS"* ]]; then
  printf "%s\n" "${prompt_ok_out}" >&2
  e2e::fail "prompt_flow.test.jh should pass"
fi
e2e::pass "prompt_flow.test.jh passes with inline mock"

# Run prompt workflow and assert tree has no embedded output (output only via log)
prompt_run_out="$(e2e::run "prompt_flow.jh")"

e2e::expect_stdout "${prompt_run_out}" <<'EOF'

Jaiph: Running prompt_flow.jh

workflow default
  ▸ prompt "e2e-prompt-please-return"
  ✓ prompt prompt (<time>)
✓ PASS workflow default (<time>)
EOF

# Prompt with variable references shows named params in tree (not positional args)
e2e::file "prompt_with_vars.jh" <<'EOF'
#!/usr/bin/env jaiph
local role = "engineer"
local task = "Fix bugs"
workflow default {
  prompt "$role does $task"
}
EOF

prompt_vars_out="$(e2e::run "prompt_with_vars.jh")"

e2e::expect_stdout "${prompt_vars_out}" <<'EOF'

Jaiph: Running prompt_with_vars.jh

workflow default
  ▸ prompt "$role does $task" (role="engineer", task="Fix bugs")
  ✓ prompt prompt (<time>)
✓ PASS workflow default (<time>)
EOF

# prompt_with_vars.jh agent .out file
e2e::expect_run_file "prompt_with_vars.jh" "000002-jaiph__prompt.out" "Command:
cursor-agent --print --output-format stream-json --stream-partial-output --workspace ${TEST_DIR} --trust ${TEST_DIR} engineer\\ does\\ Fix\\ bugs

Prompt:
engineer does Fix bugs

Final answer:
e2e-backend-no-mock-output"

# Prompt step .out file contains full agent transcript (mock run: workspace = TEST_DIR, so command is deterministic)
e2e::expect_run_file "prompt_flow.jh" "000002-jaiph__prompt.out" "Command:
cursor-agent --print --output-format stream-json --stream-partial-output --workspace ${TEST_DIR} --trust ${TEST_DIR} e2e-prompt-please-return-mock

Prompt:
e2e-prompt-please-return-mock

Final answer:
e2e-backend-no-mock-output"

# Known issue repro: async prompt branches currently collide on sequence/artifact ids.
# This test intentionally documents existing broken behavior so we can remove it
# after sequence allocation is moved into the JS runtime.
e2e::file "async_prompt_artifacts.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow left {
  prompt "async-left"
}
workflow right {
  prompt "async-right"
}
workflow default {
  run left &
  run right &
  wait
}
EOF

repro_found=0
for _attempt in $(seq 1 12); do
  e2e::run "async_prompt_artifacts.jh" >/dev/null || true
  async_run_dir="$(e2e::latest_run_dir_at "${TEST_DIR}/.jaiph/runs" "async_prompt_artifacts.jh")"
  shopt -s nullglob
  prompt_outs=( "${async_run_dir}"*jaiph__prompt.out )
  shopt -u nullglob
  summary_content="$(<"${async_run_dir}run_summary.jsonl")"
  seq2_count="$(printf '%s' "${summary_content}" | grep -c '"func":"async_prompt_artifacts::.*","kind":"workflow".*"seq":2' || true)"
  if [[ ${#prompt_outs[@]} -eq 1 || "${seq2_count}" -ge 2 ]]; then
    repro_found=1
    break
  fi
done
if [[ "${repro_found}" -eq 1 ]]; then
  e2e::pass "known async seq/artifact collision was reproduced"
else
  e2e::skip "could not reproduce async seq/artifact collision in 12 attempts"
fi

# Multi-line prompt is displayed as single line (newlines stripped from preview)
e2e::file "multiline_prompt.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  prompt "
    Line one and line two.
  "
  echo done
}
EOF

multiline_out="$(e2e::run "multiline_prompt.jh")"

e2e::expect_stdout "${multiline_out}" <<'EOF'

Jaiph: Running multiline_prompt.jh

workflow default
  ▸ prompt "Line one and line t"
  ✓ prompt prompt (<time>)
✓ PASS workflow default (<time>)
EOF

# Multiline prompt step .out file contains full agent transcript (mock run: command deterministic)
printf -v expected_multiline_prompt 'Command:\n%s\n\nPrompt:\n\n%s\n%s\n\nFinal answer:\n%s' \
  "cursor-agent --print --output-format stream-json --stream-partial-output --workspace ${TEST_DIR} --trust ${TEST_DIR} \$'\n    Line one and line two.\n  '" \
  '    Line one and line two.' \
  '  ' \
  'e2e-backend-no-mock-output'
e2e::expect_run_file "multiline_prompt.jh" "000002-jaiph__prompt.out" "${expected_multiline_prompt}"

# Given: workflow with prompt but test does not mock it -> selected backend runs (cursor by default).
e2e::file "prompt_unmatched.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  result = prompt "e2e-unmatched-prompt-never-mocked"
  printf '%s' "$result"
}
EOF

e2e::file "prompt_unmatched.test.jh" <<'EOF'
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
