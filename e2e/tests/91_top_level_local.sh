#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "top_level_local"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "top-level local with multi-line string value"
# Given
cat > "${TEST_DIR}/env_demo.jh" <<'EOF'
local role = "You are an expert.
    1. You write clearly
    2. You are concise"

local greeting = "hello world"

workflow default {
  echo "$role" > role_out.txt
  echo "$greeting" > greeting_out.txt
}
EOF

# When
jaiph run "${TEST_DIR}/env_demo.jh"

# Then: variables are accessible inside workflow
e2e::assert_file_exists "${TEST_DIR}/role_out.txt" "role variable written to file"
e2e::assert_file_exists "${TEST_DIR}/greeting_out.txt" "greeting variable written to file"

role_content="$(cat "${TEST_DIR}/role_out.txt")"
e2e::assert_contains "${role_content}" "You are an expert." "multi-line role value contains first line"
e2e::assert_contains "${role_content}" "You are concise" "multi-line role value contains last line"

greeting_content="$(cat "${TEST_DIR}/greeting_out.txt")"
e2e::assert_equals "$(echo "${greeting_content}" | tr -d '\n')" "hello world" "single-line greeting value matches"

# Assert no .out files for env_demo.jh (echo redirected to files)
shopt -s nullglob
env_demo_run_dir=( "${TEST_DIR}/.jaiph/runs/"*/*env_demo.jh/ )
[[ ${#env_demo_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for env_demo.jh"
env_demo_out_files=( "${env_demo_run_dir[0]}"*.out )
shopt -u nullglob
[[ ${#env_demo_out_files[@]} -eq 0 ]] || e2e::fail "expected no .out files for env_demo.jh, got ${#env_demo_out_files[@]}"

e2e::section "top-level local accessible in rules and functions"
# Given
cat > "${TEST_DIR}/env_all.jh" <<'EOF'
local msg = "shared-value"

rule check_msg {
  echo "$msg" > rule_msg.txt
  test -n "$msg"
}

function write_msg() {
  echo "$msg" > func_msg.txt
}

workflow default {
  ensure check_msg
  write_msg
  echo "$msg" > wf_msg.txt
}
EOF

# When
jaiph run "${TEST_DIR}/env_all.jh"

# Then: accessible from rule, function, and workflow
e2e::assert_file_exists "${TEST_DIR}/rule_msg.txt" "rule wrote msg"
e2e::assert_file_exists "${TEST_DIR}/func_msg.txt" "function wrote msg"
e2e::assert_file_exists "${TEST_DIR}/wf_msg.txt" "workflow wrote msg"

e2e::assert_equals "$(tr -d '\n' < "${TEST_DIR}/rule_msg.txt")" "shared-value" "rule sees correct value"
e2e::assert_equals "$(tr -d '\n' < "${TEST_DIR}/func_msg.txt")" "shared-value" "function sees correct value"
e2e::assert_equals "$(tr -d '\n' < "${TEST_DIR}/wf_msg.txt")" "shared-value" "workflow sees correct value"

# Assert no .out files for env_all.jh (echo redirected to files, test produces no stdout)
shopt -s nullglob
env_all_run_dir=( "${TEST_DIR}/.jaiph/runs/"*/*env_all.jh/ )
[[ ${#env_all_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for env_all.jh"
env_all_out_files=( "${env_all_run_dir[0]}"*.out )
shopt -u nullglob
[[ ${#env_all_out_files[@]} -eq 0 ]] || e2e::fail "expected no .out files for env_all.jh, got ${#env_all_out_files[@]}"

e2e::pass "top-level local declarations work correctly"
