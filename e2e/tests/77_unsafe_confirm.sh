#!/usr/bin/env bash
#
# Unsafe host-only confirmation — `jaiph run` requires explicit consent before
# running with NO sandbox when Docker would otherwise be on (JAIPH_UNSAFE=true /
# --unsafe). Mirrors the in-place `E_DOCKER_INPLACE_NO_CONFIRM` contract:
#   - Non-interactive + no consent  → abort with E_UNSAFE_NO_CONFIRM, exit 1.
#   - --yes / JAIPH_INPLACE_YES=1    → proceed host-only to PASS.
#
# JAIPH_DOCKER_ENABLED is unset for these legs (the harness defaults it to
# false) so that Docker would otherwise be ON and the unsafe opt-in is what
# turns it off — exactly the case the confirmation guards. An explicit
# JAIPH_DOCKER_ENABLED=false does NOT prompt (Docker disabled by config, not by
# the unsafe opt-in), which is why every other host-only e2e leg is unaffected.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "unsafe_confirm"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::file "flow.jh" <<'EOF'
workflow default() {
  log "hello-unsafe"
}
EOF

# ---------------------------------------------------------------------------
# No consent → abort before running
# ---------------------------------------------------------------------------
e2e::section "unsafe host-only run without consent aborts with E_UNSAFE_NO_CONFIRM"

set +e
deny_err="$(cd "${TEST_DIR}" && env -u JAIPH_DOCKER_ENABLED JAIPH_UNSAFE=true jaiph run "${TEST_DIR}/flow.jh" 2>&1 >/dev/null)"
deny_code=$?
set -e

e2e::assert_equals "${deny_code}" "1" "unsafe run without consent exits 1"
# Substring: stderr also carries a credential/preflight preamble that is not
# pinned here; the actionable error code is the contract under test.
e2e::assert_contains "${deny_err}" "E_UNSAFE_NO_CONFIRM" "actionable error code surfaced without consent"

# ---------------------------------------------------------------------------
# --yes → consent given, run proceeds host-only
# ---------------------------------------------------------------------------
e2e::section "unsafe host-only run with --yes proceeds to completion"

allow_out="$(cd "${TEST_DIR}" && env -u JAIPH_DOCKER_ENABLED jaiph run --unsafe --yes "${TEST_DIR}/flow.jh")"
# Substring: the banner line carries a timing/sandbox parenthetical that is not
# deterministic across machines; the workflow's own output is the contract.
e2e::assert_contains "${allow_out}" "hello-unsafe" "consented unsafe run produced workflow output"
