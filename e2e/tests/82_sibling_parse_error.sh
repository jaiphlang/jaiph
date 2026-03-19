#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "sibling_parse_error"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Single-file run ignores sibling parse errors"
# Given: a valid workflow file
cat > "${TEST_DIR}/valid.jh" <<'EOF'
workflow default {
  echo "valid-ok"
}
EOF

# Given: a sibling file with a syntax error
cat > "${TEST_DIR}/broken.jh" <<'EOF'
workflow broken {
  name = echo "oops" -> bad
}
EOF

# When: running the valid file
run_out="$(jaiph run "${TEST_DIR}/valid.jh")"

# Then: the valid file succeeds despite the broken sibling
expected_valid=$(printf '%s\n' \
  '' \
  'Jaiph: Running valid.jh' \
  '' \
  'workflow default' \
  '✓ PASS workflow default (<time>)')
expected_valid="${expected_valid%$'\n'}"
e2e::assert_output_equals "${run_out}" "${expected_valid}" "valid.jh succeeds despite broken sibling"

# When: building the directory (should report errors)
build_err_file="$(mktemp)"
if jaiph build "${TEST_DIR}" 2>"${build_err_file}"; then
  cat "${build_err_file}" >&2
  rm -f "${build_err_file}"
  e2e::fail "directory build should fail when a file has parse errors"
fi
build_err="$(cat "${build_err_file}")"
rm -f "${build_err_file}"

# Then: directory build reports the parse error
e2e::assert_contains "${build_err}" "broken.jh" "directory build reports error in broken.jh"
