#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "custom_agent_command"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
# Section 1: Custom agent command — display name + raw output
# ---------------------------------------------------------------------------
e2e::section "custom agent command: display name and raw stdout"

# Copy the custom agent script into the test directory
mkdir -p "${TEST_DIR}/agents"
cp "${ROOT_DIR}/e2e/agents/echo-wc.sh" "${TEST_DIR}/agents/echo-wc.sh"
chmod +x "${TEST_DIR}/agents/echo-wc.sh"

e2e::file "custom_agent.jh" <<'EOF'
config {
  agent.command = "./agents/echo-wc.sh"
}

workflow default {
  const response = prompt "one two three four five"
  log "${response}"
}
EOF

out="$(e2e::run "custom_agent.jh" 2>"${TEST_DIR}/custom_agent.stderr")"

# Run tree shows the custom command name, not "cursor"
e2e::expect_stdout "${out}" <<'EXPECTED'

Jaiph: Running custom_agent.jh

workflow default
  ▸ prompt echo-wc.sh "one two three four five"
  ✓ prompt echo-wc.sh (<time>)
  ℹ words: 5
✓ PASS workflow default (<time>)
EXPECTED

# No JSON parse errors in stderr
stderr_content="$(cat "${TEST_DIR}/custom_agent.stderr")"
if [[ "${stderr_content}" == *"SyntaxError"* ]] || [[ "${stderr_content}" == *"JSON"* ]]; then
  printf "Unexpected JSON parse errors in stderr:\n%s\n" "${stderr_content}" >&2
  e2e::fail "no JSON parse errors in stderr"
fi
e2e::pass "no JSON parse errors in stderr"

# Captured prompt response contains expected word count
dir="$(e2e::run_dir "custom_agent.jh")"
shopt -s nullglob
out_files=( "${dir}"*prompt*.out )
shopt -u nullglob
[[ ${#out_files[@]} -ge 1 ]] || e2e::fail "expected prompt .out file"
prompt_out="$(<"${out_files[0]}")"
# .out file contains raw output (non-deterministic transcript prefix); assert on word count
e2e::assert_contains "${prompt_out}" "words: 5" "prompt .out contains word count"  # transcript includes Command/Prompt headers
