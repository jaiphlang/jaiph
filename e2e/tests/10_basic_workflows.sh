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
workflow default {
  echo "hello-jh"
}
EOF

# When
hello_out="$(e2e::run "hello.jh")"

# Then
e2e::expect_stdout "${hello_out}" <<'EOF'

Jaiph: Running hello.jh

workflow default
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "hello.jh" 1
e2e::expect_out "hello.jh" "default" "hello-jh"

# Given
e2e::file "lib.jph" <<'EOF'
rule ready {
  echo "from-jph"
}
EOF

e2e::file "app.jh" <<'EOF'
import "lib.jph" as lib
workflow default {
  ensure lib.ready
  echo "mixed-ok"
}
EOF

# When
mixed_out="$(e2e::run "app.jh")"

# Then
e2e::expect_stdout "${mixed_out}" <<'EOF'

Jaiph: Running app.jh

workflow default
  ▸ rule ready
  ✓ <time>
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "app.jh" 2
e2e::expect_rule_out "app.jh" "lib.ready" "from-jph"
e2e::expect_out "app.jh" "default" "mixed-ok"

e2e::section "Git-aware rule arguments"

# Given
e2e::file "current_branch.jph" <<'EOF'
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
  e2e::git_init
  current_branch="$(e2e::git_current_branch)"

  # When
  e2e::run "current_branch.jph" "${current_branch}" >/dev/null

  # Then
  e2e::pass "current_branch.jph passes for current branch"
  e2e::expect_out_files "current_branch.jph" 0

  wrong_branch="${current_branch}-wrong"

  # When / Then
  e2e::expect_fail "current_branch.jph" "${wrong_branch}"
  e2e::pass "current_branch.jph fails for wrong branch"
)
