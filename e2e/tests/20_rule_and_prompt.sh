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
script check_passes_impl() {
  mock_ok
}
rule check_passes {
  run check_passes_impl
}
script done_impl() {
  echo "e2e-rule-pass-done"
}
workflow default {
  ensure check_passes
  msg = run done_impl
  return "$msg"
}
EOF

# When
rule_pass_out="$(e2e::run "rule_pass.jh")"

# Then
e2e::expect_stdout "${rule_pass_out}" <<'EOF'

Jaiph: Running rule_pass.jh

workflow default
  ▸ rule check_passes
  ·   ▸ script check_passes_impl
  ·   ✓ script check_passes_impl (<time>)
  ✓ rule check_passes (<time>)
  ▸ script done_impl
  ✓ script done_impl (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "rule_pass.jh" 4
e2e::expect_out "rule_pass.jh" "done_impl" "e2e-rule-pass-done"

# Given
e2e::file "rule_fail.jh" <<'EOF'
#!/usr/bin/env jaiph
script check_fails_impl() {
  mock_fail
}
script unreachable_impl() {
  echo "unreachable"
}
rule check_fails {
  run check_fails_impl
}
workflow default {
  ensure check_fails
  run unreachable_impl
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
script step_ok_impl() {
  mock_ok
}
script step_fail_impl() {
  mock_fail
}
rule step_ok {
  run step_ok_impl
}
rule step_fail {
  run step_fail_impl
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
✓ PASS workflow default (<time>)
EOF
prompt_flow_run_dir="$(e2e::run_dir "prompt_flow.jh")"
prompt_flow_out="$(<"${prompt_flow_run_dir}000001-workflow__default.out")"
e2e::assert_contains "${prompt_flow_out}" "Command:" "prompt_flow default .out contains prompt command transcript"
e2e::assert_contains "${prompt_flow_out}" "Prompt:" "prompt_flow default .out contains prompt section"
e2e::assert_contains "${prompt_flow_out}" "Final answer:" "prompt_flow default .out contains prompt final section"

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
✓ PASS workflow default (<time>)
EOF
prompt_vars_run_dir="$(e2e::run_dir "prompt_with_vars.jh")"
prompt_vars_out_file="$(<"${prompt_vars_run_dir}000001-workflow__default.out")"
e2e::assert_contains "${prompt_vars_out_file}" "engineer does Fix bugs" "prompt_with_vars transcript includes rendered prompt text"

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
script done_impl() {
  echo done
}
workflow default {
  prompt "
    Line one and line two.
  "
  run done_impl
}
EOF

multiline_out="$(e2e::run "multiline_prompt.jh")"

e2e::expect_stdout "${multiline_out}" <<'EOF'

Jaiph: Running multiline_prompt.jh

workflow default
  ▸ script done_impl
  ✓ script done_impl (<time>)
✓ PASS workflow default (<time>)
EOF
multiline_run_dir="$(e2e::run_dir "multiline_prompt.jh")"
multiline_default_out="$(<"${multiline_run_dir}000001-workflow__default.out")"
e2e::assert_contains "${multiline_default_out}" "Line one and line two." "multiline prompt transcript is captured in workflow .out"

# Given: workflow with prompt but test does not mock it -> selected backend runs (cursor by default).
e2e::file "prompt_unmatched.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  result = prompt "e2e-unmatched-prompt-never-mocked"
  return "$result"
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
