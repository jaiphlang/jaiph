#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "sibling_parse_error"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Single-file run ignores sibling parse errors"

# Given
e2e::file "valid.jh" <<'EOF'
workflow default {
  echo "valid-ok"
}
EOF

e2e::file "broken.jh" <<'EOF'
workflow broken {
  name = echo "oops" -> bad
}
EOF

# When
run_out="$(e2e::run "valid.jh")"

# Then
e2e::expect_stdout "${run_out}" <<'EOF'

Jaiph: Running valid.jh

workflow default
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "valid.jh" 1
e2e::expect_out "valid.jh" "default" "valid-ok"

# When
build_err_file="$(mktemp)"
if jaiph build "${TEST_DIR}" 2>"${build_err_file}"; then
  cat "${build_err_file}" >&2
  rm -f "${build_err_file}"
  e2e::fail "directory build should fail when a file has parse errors"
fi
build_err="$(cat "${build_err_file}")"
rm -f "${build_err_file}"

# Then
e2e::assert_contains "${build_err}" "broken.jh" "directory build reports error in broken.jh"
