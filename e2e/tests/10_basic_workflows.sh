#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "basic_workflows"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Basic workflow execution"
# Given
cat > "${TEST_DIR}/hello.jh" <<'EOF'
workflow default {
  echo "hello-jh"
}
EOF

# When
jaiph build "${TEST_DIR}/hello.jh"
hello_out="$(jaiph run "${TEST_DIR}/hello.jh")"

# Then: step output is in .out files only; stdout has tree and result
expected_hello=$(printf '%s\n' \
  '' \
  'Jaiph: Running hello.jh' \
  '' \
  'workflow default' \
  '✓ PASS workflow default (<time>)')
expected_hello="${expected_hello%$'\n'}"
e2e::assert_output_equals "${hello_out}" "${expected_hello}" "hello.jh run passes"

# Assert .out file content for hello.jh
shopt -s nullglob
hello_run_dir=( "${TEST_DIR}/.jaiph/runs/"*/*hello.jh/ )
shopt -u nullglob
[[ ${#hello_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for hello.jh"
hello_out_files=( "${hello_run_dir[0]}"*.out )
[[ ${#hello_out_files[@]} -eq 1 ]] || e2e::fail "expected one .out file for hello.jh, got ${#hello_out_files[@]}"
e2e::assert_equals "$(<"${hello_out_files[0]}")" "hello-jh" "hello.jh default workflow .out content"

# Given
cat > "${TEST_DIR}/lib.jph" <<'EOF'
rule ready {
  echo "from-jph"
}
EOF
cat > "${TEST_DIR}/app.jh" <<'EOF'
import "lib.jph" as lib
workflow default {
  ensure lib.ready
  echo "mixed-ok"
}
EOF

# When
jaiph build "${TEST_DIR}/app.jh"
mixed_out="$(jaiph run "${TEST_DIR}/app.jh")"

# Then: step output in .out files only; stdout has tree and result
expected_mixed=$(printf '%s\n' \
  '' \
  'Jaiph: Running app.jh' \
  '' \
  'workflow default' \
  '  ▸ rule ready' \
  '  ✓ <time>' \
  '✓ PASS workflow default (<time>)')
expected_mixed="${expected_mixed%$'\n'}"
e2e::assert_output_equals "${mixed_out}" "${expected_mixed}" "mixed .jh/.jph run passes"

# Assert .out file content for app.jh
shopt -s nullglob
app_run_dir=( "${TEST_DIR}/.jaiph/runs/"*/*app.jh/ )
shopt -u nullglob
[[ ${#app_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for app.jh"
app_out_files=( "${app_run_dir[0]}"*.out )
[[ ${#app_out_files[@]} -eq 2 ]] || e2e::fail "expected two .out files for app.jh, got ${#app_out_files[@]}"
app_rule_out=( "${app_run_dir[0]}"*lib__ready.out )
[[ ${#app_rule_out[@]} -eq 1 ]] || e2e::fail "expected lib__ready.out"
e2e::assert_equals "$(<"${app_rule_out[0]}")" "from-jph" "app.jh lib.ready rule .out content"
app_default_out=( "${app_run_dir[0]}"*app__default.out )
[[ ${#app_default_out[@]} -eq 1 ]] || e2e::fail "expected app__default.out"
e2e::assert_equals "$(<"${app_default_out[0]}")" "mixed-ok" "app.jh default workflow .out content"

e2e::section "Git-aware rule arguments"
# Given
cat > "${TEST_DIR}/current_branch.jph" <<'EOF'
#!/usr/bin/env jaiph
rule current_branch {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Not inside a git repository." >&2
    exit 1
  fi

  if [ "$(git branch --show-current)" != "$1" ]; then
    echo "Current branch is not '$1'." >&2
    exit 1
  fi
}

workflow default {
  ensure current_branch "$1"
}
EOF

(
  cd "${TEST_DIR}"
  # Given
  git init -b main >/dev/null 2>&1 || git init >/dev/null 2>&1
  current_branch="$(git branch --show-current)"
  [[ -n "${current_branch}" ]] || current_branch="main"

  # When
  jaiph run "./current_branch.jph" "${current_branch}" >/dev/null

  # Then
  e2e::pass "current_branch.jph passes for current branch"

  # Assert no .out files for current_branch.jph (rule produces no stdout)
  shopt -s nullglob
  cb_run_dir=( ".jaiph/runs/"*/*current_branch.jph/ )
  [[ ${#cb_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for current_branch.jph"
  cb_out_files=( "${cb_run_dir[0]}"*.out )
  shopt -u nullglob
  [[ ${#cb_out_files[@]} -eq 0 ]] || e2e::fail "expected no .out files for current_branch.jph, got ${#cb_out_files[@]}"

  wrong_branch="${current_branch}-wrong"
  # When
  if jaiph run "./current_branch.jph" "${wrong_branch}" >/dev/null 2>&1; then
    e2e::fail "current_branch.jph should fail for wrong branch"
  fi

  # Then
  e2e::pass "current_branch.jph fails for wrong branch"
)
