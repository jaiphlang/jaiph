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

cat > "${TEST_DIR}/child.jh" <<'EOF'
config {
  agent.backend = "claude"
}
workflow default {
  printf 'child:%s\n' "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"
}
EOF

cat > "${TEST_DIR}/parent.jh" <<'EOF'
import "child.jh" as child

config {
  agent.backend = "cursor"
}
workflow default {
  printf 'parent_before:%s\n' "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"
  run child.default
  printf 'parent_after:%s\n' "$JAIPH_AGENT_BACKEND" >> "$JAIPH_META_SCOPE_FILE"
}
EOF

jaiph run "${TEST_DIR}/parent.jh" >/dev/null

actual="$(cat "${META_FILE}")"
expected="$(printf '%s\n' \
  'parent_before:cursor' \
  'child:claude' \
  'parent_after:cursor')"

e2e::assert_equals "${actual}" "${expected}" "called workflow config is scoped and restored"
