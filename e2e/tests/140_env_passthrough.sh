#!/usr/bin/env bash

# Contract: `jaiph run --env` defines the workflow process's env var.
# Host mode applies the pairs to the runner env. Bare `--env KEY` forwards
# the host value, and a host-unset bare key aborts with E_ENV_MISSING
# before any process is spawned.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "env_passthrough"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# A workflow that returns whatever GREETING the workflow process sees.
e2e::file "env_show.jh" <<'EOF'
script show_impl = `echo "$GREETING"`
workflow default() {
  const g = run show_impl()
  return "${g}"
}
EOF

e2e::section "host mode — --env KEY=VALUE defines the var"

# Ensure the host has no inherited GREETING: the value can only come from --env.
unset GREETING || true
host_out="$(jaiph run --env GREETING=hi "${TEST_DIR}/env_show.jh")"
e2e::expect_stdout "${host_out}" <<'EOF'

Jaiph: Running env_show.jh

workflow default
  ▸ script show_impl
  ✓ script show_impl (<time>)
✓ PASS workflow default (<time>)

hi
EOF

e2e::section "host mode — bare --env KEY forwards the host value"

bare_out="$(GREETING=from-host jaiph run --env GREETING "${TEST_DIR}/env_show.jh")"
e2e::expect_stdout "${bare_out}" <<'EOF'

Jaiph: Running env_show.jh

workflow default
  ▸ script show_impl
  ✓ script show_impl (<time>)
✓ PASS workflow default (<time>)

from-host
EOF

e2e::section "bare --env KEY unset on the host aborts with E_ENV_MISSING before spawning"

unset GREETING || true
missing_out=""
if missing_out="$(jaiph run --env NOPE_TOKEN "${TEST_DIR}/env_show.jh" 2>&1)"; then
  e2e::fail "env: bare --env with a host-unset key should abort"
fi
# assert_contains: the error text includes the varying key name; the run never
# starts, so there is no banner/tree to compare in full.
e2e::assert_contains "${missing_out}" "E_ENV_MISSING" "env: host-unset bare --env aborts with E_ENV_MISSING"
e2e::assert_contains "${missing_out}" "NOPE_TOKEN" "env: E_ENV_MISSING names the missing key"

e2e::section "reserved keys are rejected (E_ENV_RESERVED)"

reserved_out=""
if reserved_out="$(jaiph run --env JAIPH_WORKSPACE=/x "${TEST_DIR}/env_show.jh" 2>&1)"; then
  e2e::fail "env: --env with a runtime-managed reserved key should abort"
fi
# assert_contains: only the error code is contract; the guidance text may evolve.
e2e::assert_contains "${reserved_out}" "E_ENV_RESERVED" "env: reserved key rejected with E_ENV_RESERVED"

e2e::section "invalid names are rejected (E_ENV_INVALID)"

invalid_out=""
if invalid_out="$(jaiph run --env 1BAD=x "${TEST_DIR}/env_show.jh" 2>&1)"; then
  e2e::fail "env: --env with an invalid name should abort"
fi
# assert_contains: only the error code is contract.
e2e::assert_contains "${invalid_out}" "E_ENV_INVALID" "env: invalid name rejected with E_ENV_INVALID"
