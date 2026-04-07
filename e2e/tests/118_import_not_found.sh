#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "import_not_found"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "import referencing missing file produces friendly error"
# ---------------------------------------------------------------------------

# Given — a workflow that imports a non-existent file
e2e::file "broken_import.jh" <<'EOF'
import "nonexistent.jh" as lib

workflow default() {
  run lib.deploy()
}
EOF

# When / Then — build fails with E_IMPORT_NOT_FOUND
e2e::expect_fail "broken_import.jh"

e2e::pass "import referencing missing file produces friendly error"
