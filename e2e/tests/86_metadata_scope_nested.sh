#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "config_scope_nested"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "config scoping across nested workflow calls"
META_FILE="${TEST_DIR}/config_scope.log"
export JAIPH_META_SCOPE_FILE="${META_FILE}"

# Given
e2e::file "child.jh" <<'EOF'
config {
  agent.backend = "claude"
}
script log_backend() {
  printf '%s:%s\n' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"
}
workflow default() {
  run log_backend "child"
}
EOF

e2e::file "parent.jh" <<'EOF'
import "child.jh" as child

config {
  agent.backend = "cursor"
}
script log_backend() {
  printf '%s:%s\n' "$1" "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"
}
workflow default() {
  run log_backend "parent_before"
  run child.default
  run log_backend "parent_after"
}
EOF

# When
unset JAIPH_AGENT_BACKEND 2>/dev/null || true
jaiph run "${TEST_DIR}/parent.jh" >/dev/null

# Then
actual="$(cat "${META_FILE}")"
expected="$(printf '%s\n' \
  'parent_before:cursor' \
  'child:cursor' \
  'parent_after:cursor')"

e2e::assert_equals "${actual}" "${expected}" "nested workflow inherits caller config and preserves parent state"
e2e::expect_out_files "parent.jh" 5
