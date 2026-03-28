#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "run_dir_source_name"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "run directory uses source file name (jaiph run + shebang exec)"

e2e::file "source_named.jh" <<'EOF'
#!/usr/bin/env jaiph
script done_impl() {
  echo done
}
workflow default {
  run done_impl
}
EOF
chmod +x "${TEST_DIR}/source_named.jh"

# Explicit CLI path should encode source file name in run dir.
rm -rf "${TEST_DIR}/runs_cli"
JAIPH_RUNS_DIR="${TEST_DIR}/runs_cli" jaiph run "${TEST_DIR}/source_named.jh" >/dev/null
cli_run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_cli" "source_named.jh")"
e2e::assert_contains "${cli_run_dir}" "source_named.jh/" "jaiph run uses source file in run dir"

# Direct shebang execution should follow the same naming contract.
rm -rf "${TEST_DIR}/runs_direct"
JAIPH_RUNS_DIR="${TEST_DIR}/runs_direct" "${TEST_DIR}/source_named.jh" >/dev/null
direct_run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_direct" "source_named.jh")"
e2e::assert_contains "${direct_run_dir}" "source_named.jh/" "shebang execution uses source file in run dir"
