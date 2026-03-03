#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "cli_and_parse_guards"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "jaiph test discovery and empty-directory failure"
# Given
cat > "${TEST_DIR}/ok_a.jh" <<'EOF'
workflow default {
  echo "A"
}
EOF
cat > "${TEST_DIR}/ok_a.test.jh" <<'EOF'
import "ok_a.jh" as w

test "A passes" {
  out = w.default
  expectContain out "A"
}
EOF
cat > "${TEST_DIR}/ok_b.jh" <<'EOF'
workflow default {
  echo "B"
}
EOF
cat > "${TEST_DIR}/ok_b.test.jh" <<'EOF'
import "ok_b.jh" as w

test "B passes" {
  out = w.default
  expectContain out "B"
}
EOF
mkdir -p "${TEST_DIR}/empty_tests"

# When
discovery_out="$(jaiph test "${TEST_DIR}")"

# Then
e2e::assert_contains "${discovery_out}" "testing" "jaiph test prints test execution header"
e2e::assert_contains "${discovery_out}" "ok_a.test.jh" "jaiph test runs first test file"
e2e::assert_contains "${discovery_out}" "ok_b.test.jh" "jaiph test runs second test file"
e2e::assert_contains "${discovery_out}" "✓ 1 test(s) passed" "jaiph test reports passing summary per file"

# When
empty_err="$(mktemp)"
if jaiph test "${TEST_DIR}/empty_tests" 2>"${empty_err}"; then
  cat "${empty_err}" >&2
  rm -f "${empty_err}"
  e2e::fail "jaiph test should fail when directory has no test files"
fi
empty_out="$(cat "${empty_err}")"
rm -f "${empty_err}"

# Then
e2e::assert_contains "${empty_out}" "no *.test.jh or *.test.jph files" "jaiph test reports no tests in directory"

e2e::section "jaiph run requires workflow default"
# Given
cat > "${TEST_DIR}/no_default.jh" <<'EOF'
workflow docs {
  echo "no default here"
}
EOF

# When
no_default_err="$(mktemp)"
if jaiph run "${TEST_DIR}/no_default.jh" 2>"${no_default_err}"; then
  cat "${no_default_err}" >&2
  rm -f "${no_default_err}"
  e2e::fail "jaiph run should fail when workflow default is missing"
fi
no_default_out="$(cat "${no_default_err}")"
rm -f "${no_default_err}"

# Then
e2e::assert_contains "${no_default_out}" "requires workflow 'default'" "jaiph run explains missing default workflow"

e2e::section "prompt parse guards reject shell substitution"
# Given
cat > "${TEST_DIR}/bad_prompt_subshell.jh" <<'EOF'
workflow default {
  prompt "show host $(uname)"
}
EOF
cat > "${TEST_DIR}/bad_prompt_backticks.jh" <<'EOF'
workflow default {
  prompt "show host `uname`"
}
EOF

# When
subshell_err="$(mktemp)"
if jaiph run "${TEST_DIR}/bad_prompt_subshell.jh" 2>"${subshell_err}"; then
  cat "${subshell_err}" >&2
  rm -f "${subshell_err}"
  e2e::fail "jaiph run should fail for prompt with command substitution"
fi
subshell_out="$(cat "${subshell_err}")"
rm -f "${subshell_err}"

# Then
e2e::assert_contains "${subshell_out}" "E_PARSE" "prompt command substitution emits E_PARSE"
e2e::assert_contains "${subshell_out}" "prompt cannot contain" "prompt command substitution is rejected with explicit guard"

# When
backticks_err="$(mktemp)"
if jaiph run "${TEST_DIR}/bad_prompt_backticks.jh" 2>"${backticks_err}"; then
  cat "${backticks_err}" >&2
  rm -f "${backticks_err}"
  e2e::fail "jaiph run should fail for prompt with backticks"
fi
backticks_out="$(cat "${backticks_err}")"
rm -f "${backticks_err}"

# Then
e2e::assert_contains "${backticks_out}" "E_PARSE" "prompt backticks emits E_PARSE"
e2e::assert_contains "${backticks_out}" "backticks" "prompt backticks message is explicit"
