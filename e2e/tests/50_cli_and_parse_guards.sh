#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "cli_and_parse_guards"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "jaiph test discovery and empty-directory failure"

# Given
e2e::file "ok_a.jh" <<'EOF'
script a_impl = ```
echo "A"
```
workflow default() {
  run a_impl()
}
EOF

e2e::file "ok_a.test.jh" <<'EOF'
import "ok_a.jh" as w

test "A passes" {
  out = w.default
  expectContain out "A"
}
EOF

e2e::file "ok_b.jh" <<'EOF'
script b_impl = ```
echo "B"
```
workflow default() {
  run b_impl()
}
EOF

e2e::file "ok_b.test.jh" <<'EOF'
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
e2e::expect_stdout "${discovery_out}" <<'EOF'
testing ok_a.test.jh
  ▸ A passes
  ✓ <time>
✓ 1 test(s) passed
testing ok_b.test.jh
  ▸ B passes
  ✓ <time>
✓ 1 test(s) passed
EOF

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
e2e::assert_contains "${empty_out}" "no *.test.jh files" "jaiph test reports no tests in directory"

e2e::section "jaiph run requires workflow default"

# Given
e2e::file "no_default.jh" <<'EOF'
script no_default_impl = ```
echo "no default here"
```
workflow docs() {
  run no_default_impl()
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
e2e::file "bad_prompt_subshell.jh" <<'EOF'
workflow default() {
  prompt "show host $(uname)"
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

e2e::section "shell redirection around run/ensure is rejected"

# Given — run with stdout redirect
e2e::file "run_redirect.jh" <<'EOF'
script greet = ```
echo "hello"
```
workflow default() {
  run greet() > out.txt
}
EOF

# When
redirect_err="$(mktemp)"
if jaiph run "${TEST_DIR}/run_redirect.jh" 2>"${redirect_err}"; then
  cat "${redirect_err}" >&2
  rm -f "${redirect_err}"
  e2e::fail "jaiph run should fail for run with stdout redirect"
fi
redirect_out="$(cat "${redirect_err}")"
rm -f "${redirect_err}"

# Then
e2e::assert_contains "${redirect_out}" "E_PARSE" "run redirect emits E_PARSE"
e2e::assert_contains "${redirect_out}" "shell redirection" "run redirect error mentions shell redirection"
e2e::assert_contains "${redirect_out}" "script block" "run redirect error suggests script block"

# Given — run with pipe
e2e::file "run_pipe.jh" <<'EOF'
script greet = ```
echo "hello"
```
workflow default() {
  run greet() | tr a-z A-Z
}
EOF

# When
pipe_err="$(mktemp)"
if jaiph run "${TEST_DIR}/run_pipe.jh" 2>"${pipe_err}"; then
  cat "${pipe_err}" >&2
  rm -f "${pipe_err}"
  e2e::fail "jaiph run should fail for run with pipe"
fi
pipe_out="$(cat "${pipe_err}")"
rm -f "${pipe_err}"

# Then
e2e::assert_contains "${pipe_out}" "E_PARSE" "run pipe emits E_PARSE"
e2e::assert_contains "${pipe_out}" "shell redirection" "run pipe error mentions shell redirection"

# Given — run with background &
e2e::file "run_bg.jh" <<'EOF'
script greet = ```
echo "hello"
```
workflow default() {
  run greet() &
}
EOF

# When
bg_err="$(mktemp)"
if jaiph run "${TEST_DIR}/run_bg.jh" 2>"${bg_err}"; then
  cat "${bg_err}" >&2
  rm -f "${bg_err}"
  e2e::fail "jaiph run should fail for run with background &"
fi
bg_out="$(cat "${bg_err}")"
rm -f "${bg_err}"

# Then
e2e::assert_contains "${bg_out}" "E_PARSE" "run background emits E_PARSE"
e2e::assert_contains "${bg_out}" "shell redirection" "run background error mentions shell redirection"
