#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "script_steps"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "script calls in workflow tree and side effects"

# Given
e2e::file "scripts.jh" <<'EOF'
script changed_files = ```
echo "fn-called" > script_called.txt
```

workflow default() {
  run changed_files()
}
EOF
rm -f "${TEST_DIR}/script_called.txt"

# When
script_out="$(e2e::run "scripts.jh")"

# Then
e2e::assert_file_exists "${TEST_DIR}/script_called.txt" "script step command executed and changed filesystem"

e2e::expect_stdout "${script_out}" <<'EOF'

Jaiph: Running scripts.jh

workflow default
  ▸ script changed_files
  ✓ script changed_files (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "scripts.jh" 2

e2e::section "run, ensure, and script argument forwarding"

# Given
e2e::file "args_forwarding.jh" <<'EOF'
script expect_args_impl = "return 0"

rule expect_args(a, b) {
  run expect_args_impl()
}

script write_args = ```
printf "%s|%s\n" "$1" "$2" > script_args.txt
```

script write_workflow_args = ```
printf "%s|%s\n" "$1" "$2" > workflow_args.txt
```

workflow called(a, b) {
  ensure expect_args(arg1, arg2)
  run write_args(arg1, arg2)
  run write_workflow_args(arg1, arg2)
}

workflow default() {
  run called("one", "two words")
}
EOF
rm -f "${TEST_DIR}/script_args.txt" "${TEST_DIR}/workflow_args.txt"

# When
args_out="$(e2e::run "args_forwarding.jh" 2>&1)"

# Then
e2e::assert_file_exists "${TEST_DIR}/script_args.txt" "script received forwarded arguments"
e2e::assert_file_exists "${TEST_DIR}/workflow_args.txt" "workflow received arguments from run"
e2e::assert_equals "$(tr -d '\r\n' < "${TEST_DIR}/script_args.txt")" "one|two words" "script args are forwarded"
e2e::assert_equals "$(tr -d '\r\n' < "${TEST_DIR}/workflow_args.txt")" "one|two words" "workflow args are forwarded"

e2e::expect_stdout "${args_out}" <<'EOF'

Jaiph: Running args_forwarding.jh

workflow default
  ▸ workflow called (1="one", 2="two words")
  ·   ▸ rule expect_args (1="one", 2="two words")
  ·   ·   ▸ script expect_args_impl
  ·   ·   ✓ script expect_args_impl (<time>)
  ·   ✓ rule expect_args (<time>)
  ·   ▸ script write_args (1="one", 2="two words")
  ·   ✓ script write_args (<time>)
  ·   ▸ script write_workflow_args (1="one", 2="two words")
  ·   ✓ script write_workflow_args (<time>)
  ✓ workflow called (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "args_forwarding.jh" 6

e2e::pass "run, ensure, and script all support argument forwarding"
