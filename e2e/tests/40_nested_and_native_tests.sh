#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "nested_and_native_tests"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Output tree and nested workflow visibility"

# Given
e2e::file "nested_inner.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  echo "e2e-nested-inner"
}
EOF

e2e::file "nested_run.jh" <<'EOF'
#!/usr/bin/env jaiph
import "nested_inner.jh" as inner
workflow default {
  run inner.default
  echo "e2e-nested-outer"
}
EOF

# When
nested_out="$(e2e::run "nested_run.jh")"

# Then
e2e::expect_stdout "${nested_out}" <<'EOF'

Jaiph: Running nested_run.jh

workflow default
  ▸ workflow default
  ✓ workflow default (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "nested_run.jh" 2
e2e::expect_file "*nested_inner__default.out" <<'EOF'
e2e-nested-inner
EOF
e2e::expect_file "*nested_run__default.out" <<'EOF'
e2e-nested-outer
EOF

e2e::section "Native *.test.jh flow"

# Given
e2e::file "workflow_greeting.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  prompt "e2e-greeting-prompt"
  echo "done"
}
EOF

e2e::file "workflow_greeting.test.jh" <<'EOF'
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

# Given
e2e::file "unmatched_mock_block.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  result = prompt "e2e-unmatched-prompt-never-mocked"
  printf '%s' "$result"
}
EOF

e2e::file "unmatched_mock_block.test.jh" <<'EOF'
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

# When
set +e
if [[ -f "${ROOT_DIR}/dist/src/jaiph_stdlib.sh" ]]; then
  export JAIPH_STDLIB="${ROOT_DIR}/dist/src/jaiph_stdlib.sh"
fi
unmatched_out="$(jaiph test "${TEST_DIR}/unmatched_mock_block.test.jh" 2>&1)"
unmatched_exit=$?
set -e

# Then
if [[ $unmatched_exit -eq 0 ]]; then
  printf "%s\n" "${unmatched_out}" >&2
  e2e::fail "unmatched_mock_block.test.jh should exit 1 when no branch matches"
fi
if [[ "${unmatched_out}" != *"workflow exited with status"* ]] && [[ "${unmatched_out}" != *"expectContain failed"*"0 chars"* ]]; then
  printf "%s\n" "${unmatched_out}" >&2
  e2e::fail "unmatched prompt should report workflow failure or expectContain failure"
fi
e2e::pass "mock prompt block without else fails when prompt never matched"

e2e::section "Fibonacci workflow: managed run function (iterative impl, single step in tree)"

# When
fib_out="$(jaiph run "${ROOT_DIR}/e2e/fibonacci.jh" 3)"

# Then
e2e::expect_stdout "${fib_out}" <<'EOF'

Jaiph: Running fibonacci.jh

workflow default (1="3")
  ▸ rule ensure_is_number (1="3")
  ✓ rule ensure_is_number (<time>)
  ▸ script fib (1="<script-path>", 2="3")
  ✓ script fib (<time>)
  ℹ 2
✓ PASS workflow default (<time>)
EOF

# Assert .out file content for fibonacci.jh (run from e2e/ dir, workspace root is repo root)
fib_run_dir="$(e2e::latest_run_dir_at "${ROOT_DIR}/.jaiph/runs" "fibonacci.jh")"

shopt -s nullglob
fib_out_files=( "${fib_run_dir}"*"__fib.out" )
shopt -u nullglob
[[ ${#fib_out_files[@]} -eq 1 ]] || e2e::fail "expected one fib .out file for fibonacci.jh, got ${#fib_out_files[@]}"
e2e::assert_equals "$(<"${fib_out_files[0]}")" "2" "fibonacci.jh fib step .out content (fib(3)=2)"

e2e::section "Parametrized workflow, rule, and prompt: params in tree (exact output)"

# Given
e2e::file "param_demo.jh" <<'EOF'
#!/usr/bin/env jaiph
rule check_arg {
  [ -n "$1" ]
}
workflow default {
  ensure check_arg "$1"
  response = prompt "e2e-param-prompt-text"
  echo "$response"
}
EOF

e2e::file "param_demo.test.jh" <<'EOF'
#!/usr/bin/env jaiph
import "param_demo.jh" as w

test "parametrized workflow and rule show params in tree; prompt shows value only" {
  mock prompt "e2e-param-mock-response"
  response = w.default "Alice"
  expectContain response "workflow default (1="
  expectContain response "rule check_arg (1="
  expectContain response "e2e-param-mock-response"
}
EOF

# When
param_test_out="$(jaiph test "${TEST_DIR}/param_demo.test.jh")"

# Then
if [[ "${param_test_out}" != *"passed"* ]] && [[ "${param_test_out}" != *"PASS"* ]]; then
  printf "%s\n" "${param_test_out}" >&2
  e2e::fail "param_demo.test.jh should pass"
fi
e2e::pass "parametrized workflow/rule/prompt show params in tree"

# Exact output: run workflow with args, no prompt (so no agent needed)
e2e::file "param_run_only.jh" <<'EOF'
#!/usr/bin/env jaiph
rule need_one {
  [ -n "$1" ]
}
workflow default {
  ensure need_one "$1"
  echo "e2e-param-done"
}
EOF

# When
param_run_out="$(e2e::run "param_run_only.jh" Bob)"

# Then
e2e::expect_stdout "${param_run_out}" <<'EOF'

Jaiph: Running param_run_only.jh

workflow default (1="Bob")
  ▸ rule need_one (1="Bob")
  ✓ rule need_one (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "param_run_only.jh" 1
e2e::expect_out "param_run_only.jh" "default" "e2e-param-done"
