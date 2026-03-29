#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "basic_workflows"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Basic workflow execution"

# Given
e2e::file "hello.jh" <<'EOF'
script hello_impl() {
  echo "hello-jh"
}
workflow default {
  msg = run hello_impl
  return "${msg}"
}
EOF

# When
hello_out="$(e2e::run "hello.jh")"

# Then
e2e::expect_stdout "${hello_out}" <<'EOF'

Jaiph: Running hello.jh

workflow default
  ▸ script hello_impl
  ✓ script hello_impl (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "hello.jh" 2
e2e::expect_out "hello.jh" "hello_impl" "hello-jh"

# Given
e2e::file "lib.jh" <<'EOF'
script ready_impl() {
  echo "from-lib"
}
rule ready {
  result = run ready_impl
  return "${result}"
}
EOF

e2e::file "app.jh" <<'EOF'
import "lib.jh" as lib
script mixed_ok_impl() {
  echo "mixed-ok"
}
workflow default {
  ensure lib.ready
  msg = run mixed_ok_impl
  return "${msg}"
}
EOF

# When
mixed_out="$(e2e::run "app.jh")"

# Then
e2e::expect_stdout "${mixed_out}" <<'EOF'

Jaiph: Running app.jh

workflow default
  ▸ rule ready
  ·   ▸ script ready_impl
  ·   ✓ script ready_impl (<time>)
  ✓ rule ready (<time>)
  ▸ script mixed_ok_impl
  ✓ script mixed_ok_impl (<time>)
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "app.jh" 4
e2e::expect_out "app.jh" "ready_impl" "from-lib"
e2e::expect_out "app.jh" "mixed_ok_impl" "mixed-ok"

e2e::section "Git-aware rule arguments"

# Given
e2e::file "current_branch.jh" <<'EOF'
#!/usr/bin/env jaiph
script current_branch_impl() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Not inside a git repository." >&2
    exit 1
  fi

  if [ "$(git branch --show-current)" != "$1" ]; then
    echo "Current branch is not '$1'." >&2
    exit 1
  fi
}
rule current_branch {
  run current_branch_impl "${arg1}"
}

workflow default {
  ensure current_branch "${arg1}"
}
EOF

(
  cd "${TEST_DIR}"

  # Given
  e2e::git_init
  current_branch="$(e2e::git_current_branch)"

  # When
  e2e::run "current_branch.jh" "${current_branch}" >/dev/null

  # Then
  e2e::pass "current_branch.jh passes for current branch"
  e2e::expect_out_files "current_branch.jh" 3

  wrong_branch="${current_branch}-wrong"

  # When / Then
  e2e::expect_fail "current_branch.jh" "${wrong_branch}"
  e2e::pass "current_branch.jh fails for wrong branch"
)
