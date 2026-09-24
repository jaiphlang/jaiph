#!/usr/bin/env bash
# A free-form line in a def is rejected before a run starts.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "shell_line_rejected"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::file "tools.jh" <<'EOF'
export def main(name) {
  echo "Hello ${name}"
}
EOF

e2e::section "a free-form def line is rejected"
err="$(mktemp)"
if e2e::run "tools.jh" 2>"${err}"; then
  cat "${err}" >&2
  rm -f "${err}"
  e2e::fail "tools.jh should fail to parse"
fi
e2e::assert_contains "$(cat "${err}")" "not a statement" "free-form line is E_PARSE"
rm -f "${err}"
