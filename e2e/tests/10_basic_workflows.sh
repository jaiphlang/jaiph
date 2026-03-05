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

# Then: exact tree (shell-only workflow, no step rows)
expected_hello=$(printf '%s\n' \
  '' \
  'running hello.jh' \
  '' \
  'workflow default' \
  'hello-jh' \
  '✓ PASS workflow default (<time>)')
expected_hello="${expected_hello%$'\n'}"
e2e::assert_output_equals "${hello_out}" "${expected_hello}" "hello.jh run passes"

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

# Then: exact tree (ensure lib.ready then shell)
expected_mixed=$(printf '%s\n' \
  '' \
  'running app.jh' \
  '' \
  'workflow default' \
  '  ▸ rule ready' \
  '  ✓ <time>' \
  'from-jph' \
  'mixed-ok' \
  '✓ PASS workflow default (<time>)')
expected_mixed="${expected_mixed%$'\n'}"
e2e::assert_output_equals "${mixed_out}" "${expected_mixed}" "mixed .jh/.jph run passes"

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

  wrong_branch="${current_branch}-wrong"
  # When
  if jaiph run "./current_branch.jph" "${wrong_branch}" >/dev/null 2>&1; then
    e2e::fail "current_branch.jph should fail for wrong branch"
  fi

  # Then
  e2e::pass "current_branch.jph fails for wrong branch"
)
