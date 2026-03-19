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

# Unset so run does not set JAIPH_AGENT_BACKEND_LOCKED=1; nested workflow must apply its own config.
unset JAIPH_AGENT_BACKEND 2>/dev/null || true
jaiph run "${TEST_DIR}/parent.jh" >/dev/null

actual="$(cat "${META_FILE}")"
expected="$(printf '%s\n' \
  'parent_before:cursor' \
  'child:claude' \
  'parent_after:cursor')"

e2e::assert_equals "${actual}" "${expected}" "called workflow config is scoped and restored"

# Assert no .out files for parent.jh (all output redirected to file via >>)
shopt -s nullglob
parent_run_dir=( "${TEST_DIR}/.jaiph/runs/"*/*parent.jh/ )
[[ ${#parent_run_dir[@]} -eq 1 ]] || e2e::fail "expected one run dir for parent.jh"
parent_out_files=( "${parent_run_dir[0]}"*.out )
shopt -u nullglob
[[ ${#parent_out_files[@]} -eq 0 ]] || e2e::fail "expected no .out files for parent.jh, got ${#parent_out_files[@]}"
