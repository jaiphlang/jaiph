#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "assign_capture"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "Assignment capture for ensure and shell"

# Given
cp "${ROOT_DIR}/e2e/assign_capture.jh" "${TEST_DIR}/assign_capture.jh"

# When
assign_out="$(e2e::run "assign_capture.jh")"

# Then
e2e::expect_stdout "${assign_out}" <<'EOF'

Jaiph: Running assign_capture.jh

workflow default
✓ PASS workflow default (<time>)
EOF

e2e::expect_out_files "assign_capture.jh" 1
e2e::expect_file "*assign_capture__default.out" <<'EOF'
response=captured-stdout
out=shell-capture
EOF
