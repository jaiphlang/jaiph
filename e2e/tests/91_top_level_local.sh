#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "top_level_local"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "top-level const with multi-line string value"

# Given
e2e::file "env_demo.jh" <<'EOF'
const role = "You are an expert.
    1. You write clearly
    2. You are concise"

const greeting = "hello world"

script write_role = "echo \"$1\" > role_out.txt"

script write_greeting = "echo \"$1\" > greeting_out.txt"

workflow default() {
  run write_role(role)
  run write_greeting(greeting)
}
EOF

# When
jaiph run "${TEST_DIR}/env_demo.jh"

# Then
e2e::assert_file_exists "${TEST_DIR}/role_out.txt" "role variable written to file"
e2e::assert_file_exists "${TEST_DIR}/greeting_out.txt" "greeting variable written to file"

role_content="$(cat "${TEST_DIR}/role_out.txt")"
e2e::assert_contains "${role_content}" "You are an expert." "multi-line role value contains first line"
e2e::assert_contains "${role_content}" "You are concise" "multi-line role value contains last line"

greeting_content="$(cat "${TEST_DIR}/greeting_out.txt")"
e2e::assert_equals "$(echo "${greeting_content}" | tr -d '\n')" "hello world" "single-line greeting value matches"

e2e::expect_out_files "env_demo.jh" 3

e2e::section "top-level const accessible in rules and workflows (not scripts)"

# Scripts run in full isolation and cannot see module-level consts.
# Rules and workflows still see them via env shims.

# Given
e2e::file "env_all.jh" <<'EOF'
const msg = "shared-value"

script check_msg_impl = ```
echo "$1" > rule_msg.txt
test -n "$1"
```

rule check_msg() {
  run check_msg_impl(msg)
}

script write_msg = "echo \"${msg:-}\" > func_msg.txt"

script write_wf_msg = "echo \"$1\" > wf_msg.txt"

workflow default() {
  ensure check_msg()
  run write_msg()
  run write_wf_msg(msg)
}
EOF

# When
jaiph run "${TEST_DIR}/env_all.jh"

# Then
e2e::assert_file_exists "${TEST_DIR}/rule_msg.txt" "rule wrote msg"
e2e::assert_file_exists "${TEST_DIR}/func_msg.txt" "function wrote msg"
e2e::assert_file_exists "${TEST_DIR}/wf_msg.txt" "workflow wrote msg"

e2e::assert_equals "$(tr -d '\n' < "${TEST_DIR}/rule_msg.txt")" "shared-value" "rule sees correct value"
e2e::assert_equals "$(tr -d '\n' < "${TEST_DIR}/func_msg.txt")" "" "script does NOT see module const (isolation)"
e2e::assert_equals "$(tr -d '\n' < "${TEST_DIR}/wf_msg.txt")" "shared-value" "workflow sees correct value"

e2e::expect_out_files "env_all.jh" 5

e2e::pass "top-level const declarations: rules+workflows see vars, scripts isolated"
