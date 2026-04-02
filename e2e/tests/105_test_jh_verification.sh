#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "test_jh_verification"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ==========================================================================
# Section 1: Passing test with import, mock prompt, mock script, mock
#            workflow, mock rule, and assertions — exact output verification
# ==========================================================================

e2e::section "jaiph test: representative passing .test.jh"

# Given
e2e::file "lib.jh" <<'EOF'
#!/usr/bin/env jaiph
script validate_impl = "[ -n \"$1\" ] && echo \"valid\""

rule validate(input) {
  run validate_impl(arg1)
}

script deploy_impl = "echo \"deployed\""

workflow deploy() {
  run deploy_impl()
}

workflow default(input) {
  ensure validate(input)
  const response = prompt "summarize deployment"
  run deploy()
}
EOF

e2e::file "lib.test.jh" <<'EOF'
import "lib.jh" as lib

test "full orchestration with all mock types" {
  mock prompt "deployment summary"

  mock rule lib.validate {
    echo "mock-valid"
    exit 0
  }

  mock workflow lib.deploy {
    echo "mock-deployed"
  }

  out = lib.default "prod"
  expectContain out "deployment summary"
  expectContain out "mock-deployed"
}

test "mock script replaces script body" {
  mock prompt "ok"

  mock script lib.validate_impl {
    echo "stubbed-validate"
  }

  out = lib.default "prod"
  expectContain out "stubbed-validate"
}
EOF

# When
pass_out="$(jaiph test "${TEST_DIR}/lib.test.jh" 2>&1)"

# Then
e2e::expect_stdout "${pass_out}" <<'EOF'
testing lib.test.jh
  ▸ full orchestration with all mock types
  ✓ <time>
  ▸ mock script replaces script body
  ✓ <time>
✓ 2 test(s) passed
EOF

# ==========================================================================
# Section 2: Failing test — verify exit code and output
# ==========================================================================

e2e::section "jaiph test: predictable failure output"

e2e::file "fail_lib.jh" <<'EOF'
#!/usr/bin/env jaiph
script greet_impl = "echo \"hello world\""

workflow default() {
  run greet_impl()
}
EOF

e2e::file "fail_lib.test.jh" <<'EOF'
import "fail_lib.jh" as f

test "passes when output matches" {
  out = f.default
  expectContain out "hello world"
}

test "fails on wrong expectation" {
  out = f.default
  expectEqual out "goodbye world"
}
EOF

# When
set +e
fail_out="$(jaiph test "${TEST_DIR}/fail_lib.test.jh" 2>&1)"
fail_exit=$?
set -e

# Then
if [[ ${fail_exit} -eq 0 ]]; then
  printf "%s\n" "${fail_out}" >&2
  e2e::fail "fail_lib.test.jh should exit non-zero"
fi
e2e::pass "failing test exits non-zero (exit=${fail_exit})"

e2e::expect_stdout "${fail_out}" <<'EOF'
testing fail_lib.test.jh
  ▸ passes when output matches
  ✓ <time>
  ▸ fails on wrong expectation
  ✗ expectEqual failed: <time>
    - goodbye world
    + hello world



✗ 1 / 2 test(s) failed
  - fails on wrong expectation
EOF

# ==========================================================================
# Section 3: mock function rejected with migration error
# ==========================================================================

e2e::section "jaiph test: mock function syntax rejected"

e2e::file "old_syntax.jh" <<'EOF'
#!/usr/bin/env jaiph
script helper = "echo \"real\""

workflow default() {
  run helper()
}
EOF

e2e::file "old_syntax.test.jh" <<'EOF'
import "old_syntax.jh" as app

test "uses deprecated mock function" {
  mock function app.helper {
    echo "stubbed"
  }

  out = app.default
  expectContain out "stubbed"
}
EOF

# When
set +e
old_out="$(jaiph test "${TEST_DIR}/old_syntax.test.jh" 2>&1)"
old_exit=$?
set -e

# Then
if [[ ${old_exit} -eq 0 ]]; then
  printf "%s\n" "${old_out}" >&2
  e2e::fail "old mock function syntax should fail"
fi
# assert_contains: error message includes dynamic file path and line number
e2e::assert_contains "${old_out}" '"mock function" is no longer supported; use "mock script"' \
  "mock function produces migration error"

# ==========================================================================
# Section 4: jaiph test discovers and runs .test.jh from directory
# ==========================================================================

e2e::section "jaiph test: directory discovery"

# Remove invalid fixture before discovery (parser will reject mock function)
rm -f "${TEST_DIR}/old_syntax.test.jh"

# When
set +e
dir_out="$(jaiph test "${TEST_DIR}" 2>&1)"
dir_exit=$?
set -e

# Then — one of the two files has a failing test, so overall should be non-zero
if [[ ${dir_exit} -eq 0 ]]; then
  printf "%s\n" "${dir_out}" >&2
  e2e::fail "directory run should fail (fail_lib.test.jh has a failing test)"
fi
# assert_contains: directory run output includes both files with variable ordering
e2e::assert_contains "${dir_out}" "lib.test.jh" "directory run found lib.test.jh"
e2e::assert_contains "${dir_out}" "fail_lib.test.jh" "directory run found fail_lib.test.jh"
