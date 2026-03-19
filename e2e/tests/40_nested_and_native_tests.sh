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

# Then: step output in .out files only; stdout has tree and result
expected_nested_out=$(printf '%s\n' \
  '' \
  'Jaiph: Running nested_run.jh' \
  '' \
  'workflow default' \
  '  ▸ workflow default' \
  '  ✓ <time>' \
  '✓ PASS workflow default (<time>)')
expected_nested_out="${expected_nested_out%$'\n'}"
normalized_nested="$(e2e::normalize_output "${nested_out}")"
e2e::assert_equals "${normalized_nested}" "${expected_nested_out}" "nested run output matches expected tree"

# Assert .out file content for nested_run.jh
shopt -s nullglob
nested_run_dir=( "${TEST_DIR}/.jaiph/runs/"*/*nested_run.jh/ )
shopt -u nullglob
[[ ${#nested_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for nested_run.jh"
nested_out_files=( "${nested_run_dir[0]}"*.out )
[[ ${#nested_out_files[@]} -eq 2 ]] || e2e::fail "expected two .out files for nested_run.jh, got ${#nested_out_files[@]}"
nested_inner_out=( "${nested_run_dir[0]}"*nested_inner__default.out )
[[ ${#nested_inner_out[@]} -eq 1 ]] || e2e::fail "expected nested_inner__default.out"
e2e::assert_equals "$(<"${nested_inner_out[0]}")" "e2e-nested-inner" "nested_run.jh inner workflow .out content"
nested_outer_out=( "${nested_run_dir[0]}"*nested_run__default.out )
[[ ${#nested_outer_out[@]} -eq 1 ]] || e2e::fail "expected nested_run__default.out"
e2e::assert_equals "$(<"${nested_outer_out[0]}")" "e2e-nested-outer" "nested_run.jh outer workflow .out content"

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

e2e::section "Mock prompt block with no else: unmatched prompt fails with clear message"
# Given: workflow prompts with string that mock block does not match
cat > "${TEST_DIR}/unmatched_mock_block.jh" <<'EOF'
#!/usr/bin/env jaiph
workflow default {
  result = prompt "e2e-unmatched-prompt-never-mocked"
  printf '%s' "$result"
}
EOF
cat > "${TEST_DIR}/unmatched_mock_block.test.jh" <<'EOF'
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

# When: run test (expect failure)
set +e
if [[ -f "${ROOT_DIR}/dist/src/jaiph_stdlib.sh" ]]; then
  export JAIPH_STDLIB="${ROOT_DIR}/dist/src/jaiph_stdlib.sh"
fi
unmatched_out="$(jaiph test "${TEST_DIR}/unmatched_mock_block.test.jh" 2>&1)"
unmatched_exit=$?
set -e

# Then: exit 1 and stderr reports failed workflow execution
if [[ $unmatched_exit -eq 0 ]]; then
  printf "%s\n" "${unmatched_out}" >&2
  e2e::fail "unmatched_mock_block.test.jh should exit 1 when no branch matches"
fi
# Either explicit workflow failure message or expectContain failed (empty output) indicates correct behavior
if [[ "${unmatched_out}" != *"workflow exited with status"* ]] && [[ "${unmatched_out}" != *"expectContain failed"*"0 chars"* ]]; then
  printf "%s\n" "${unmatched_out}" >&2
  e2e::fail "unmatched prompt should report workflow failure or expectContain failure"
fi
e2e::pass "mock prompt block without else fails when prompt never matched"

e2e::section "Fibonacci workflow: step params show values only (no labels, no impl ref)"
# When: run fibonacci.jh with n=3
fib_out="$(jaiph run "${ROOT_DIR}/e2e/fibonacci.jh" 3)"
# Then: full output matches expected tree (params as values only, normalized time)
expected_fib_out=$(printf '%s\n' \
  '' \
  'Jaiph: Running fibonacci.jh' \
  '' \
  'workflow default (3)' \
  '  ▸ rule ensure_is_number (3)' \
  '  ✓ <time>' \
  '  ▸ function fib (3)' \
  '  ·   ▸ function fib (2)' \
  '  ·   ·   ▸ function fib (1)' \
  '  ·   ·   ✓ <time>' \
  '  ·   ·   ▸ function fib (0)' \
  '  ·   ·   ✓ <time>' \
  '  ·   ✓ <time>' \
  '  ·   ▸ function fib (1)' \
  '  ·   ✓ <time>' \
  '  ✓ <time>' \
  '✓ PASS workflow default (<time>)')
expected_fib_out="${expected_fib_out%$'\n'}"
normalized_fib="$(e2e::normalize_output "${fib_out}")"
e2e::assert_equals "${normalized_fib}" "${expected_fib_out}" "fibonacci run output matches expected tree"

# Assert .out file content for fibonacci.jh (run from e2e/ dir, workspace root is repo root)
shopt -s nullglob
fib_run_dir=( "${ROOT_DIR}/.jaiph/runs/"*/*fibonacci.jh/ )
shopt -u nullglob
[[ ${#fib_run_dir[@]} -ge 1 ]] || e2e::fail "expected at least one run dir for fibonacci.jh"
# fibonacci.jh runs from repo root and may have historical artifacts from prior local/e2e runs.
# Use the most recent matching run dir for deterministic assertions.
latest_fib_run_dir="${fib_run_dir[$((${#fib_run_dir[@]} - 1))]}"
fib_out_files=( "${latest_fib_run_dir}"*.out )
[[ ${#fib_out_files[@]} -eq 1 ]] || e2e::fail "expected one .out file for fibonacci.jh, got ${#fib_out_files[@]}"
e2e::assert_equals "$(<"${fib_out_files[0]}")" "2" "fibonacci.jh default workflow .out content (fib(3)=2)"

e2e::section "Parametrized workflow, rule, and prompt: params in tree (exact output)"
# Given: workflow with ensure (rule with arg) and prompt; we mock prompt and assert tree contains params
cat > "${TEST_DIR}/param_demo.jh" <<'EOF'
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
cat > "${TEST_DIR}/param_demo.test.jh" <<'EOF'
#!/usr/bin/env jaiph
import "param_demo.jh" as w

test "parametrized workflow and rule show params in tree; prompt shows value only" {
  mock prompt "e2e-param-mock-response"
  response = w.default "Alice"
  expectContain response "workflow default (Alice)"
  expectContain response "rule check_arg (Alice)"
  expectContain response "prompt (" 
  expectContain response "e2e-param-mock-response"
}
EOF

# When: run test
param_test_out="$(jaiph test "${TEST_DIR}/param_demo.test.jh")"

# Then: test passes and tree had correct param display
if [[ "${param_test_out}" != *"passed"* ]] && [[ "${param_test_out}" != *"PASS"* ]]; then
  printf "%s\n" "${param_test_out}" >&2
  e2e::fail "param_demo.test.jh should pass"
fi
e2e::pass "parametrized workflow/rule/prompt show params in tree"

# Exact output: run workflow with args, no prompt (so no agent needed)
cat > "${TEST_DIR}/param_run_only.jh" <<'EOF'
#!/usr/bin/env jaiph
rule need_one {
  [ -n "$1" ]
}
workflow default {
  ensure need_one "$1"
  echo "e2e-param-done"
}
EOF
param_run_out="$(jaiph run "${TEST_DIR}/param_run_only.jh" Bob)"
expected_param_run=$(printf '%s\n' \
  '' \
  'Jaiph: Running param_run_only.jh' \
  '' \
  'workflow default (Bob)' \
  '  ▸ rule need_one (Bob)' \
  '  ✓ <time>' \
  '✓ PASS workflow default (<time>)')
expected_param_run="${expected_param_run%$'\n'}"
normalized_param_run="$(e2e::normalize_output "${param_run_out}")"
e2e::assert_equals "${normalized_param_run}" "${expected_param_run}" "parametrized run output matches expected tree"

# Assert .out file content for param_run_only.jh
shopt -s nullglob
param_run_dir=( "${TEST_DIR}/.jaiph/runs/"*/*param_run_only.jh/ )
shopt -u nullglob
[[ ${#param_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for param_run_only.jh"
param_out_files=( "${param_run_dir[0]}"*.out )
[[ ${#param_out_files[@]} -eq 1 ]] || e2e::fail "expected one .out file for param_run_only.jh, got ${#param_out_files[@]}"
e2e::assert_equals "$(<"${param_out_files[0]}")" "e2e-param-done" "param_run_only.jh default workflow .out content"
