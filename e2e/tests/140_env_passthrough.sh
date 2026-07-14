#!/usr/bin/env bash

# Contract: `jaiph run --env` defines the workflow process's env var in every
# execution mode. Host mode applies the pairs to the runner env; Docker forwards
# them as explicit `-e KEY=VALUE` container args that bypass the fail-closed
# ENV_ALLOW_PREFIXES allowlist. Bare `--env KEY` forwards the host value, and a
# host-unset bare key aborts with E_ENV_MISSING before any process is spawned.

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
host_out="$(JAIPH_DOCKER_ENABLED=false jaiph run --env GREETING=hi "${TEST_DIR}/env_show.jh")"
e2e::expect_stdout "${host_out}" <<'EOF'

Jaiph: Running env_show.jh

workflow default
  ▸ script show_impl
  ✓ script show_impl (<time>)
✓ PASS workflow default (<time>)

hi
EOF

e2e::section "host mode — bare --env KEY forwards the host value"

bare_out="$(GREETING=from-host JAIPH_DOCKER_ENABLED=false jaiph run --env GREETING "${TEST_DIR}/env_show.jh")"
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
if missing_out="$(JAIPH_DOCKER_ENABLED=false jaiph run --env NOPE_TOKEN "${TEST_DIR}/env_show.jh" 2>&1)"; then
  e2e::fail "env: bare --env with a host-unset key should abort"
fi
# assert_contains: the error text includes the varying key name; the run never
# starts, so there is no banner/tree to compare in full.
e2e::assert_contains "${missing_out}" "E_ENV_MISSING" "env: host-unset bare --env aborts with E_ENV_MISSING"
e2e::assert_contains "${missing_out}" "NOPE_TOKEN" "env: E_ENV_MISSING names the missing key"

e2e::section "reserved keys are rejected (E_ENV_RESERVED)"

reserved_out=""
if reserved_out="$(JAIPH_DOCKER_ENABLED=false jaiph run --env JAIPH_WORKSPACE=/x "${TEST_DIR}/env_show.jh" 2>&1)"; then
  e2e::fail "env: --env with a runtime-managed reserved key should abort"
fi
# assert_contains: only the error code is contract; the guidance text may evolve.
e2e::assert_contains "${reserved_out}" "E_ENV_RESERVED" "env: reserved key rejected with E_ENV_RESERVED"

e2e::section "invalid names are rejected (E_ENV_INVALID)"

invalid_out=""
if invalid_out="$(JAIPH_DOCKER_ENABLED=false jaiph run --env 1BAD=x "${TEST_DIR}/env_show.jh" 2>&1)"; then
  e2e::fail "env: --env with an invalid name should abort"
fi
# assert_contains: only the error code is contract.
e2e::assert_contains "${invalid_out}" "E_ENV_INVALID" "env: invalid name rejected with E_ENV_INVALID"

# ---------------------------------------------------------------------------
# Docker leg: the pairs cross the sandbox boundary bypassing the allowlist.
# MY_TOKEN is not on ENV_ALLOW_PREFIXES, so without --env it must be unset
# inside the container, and with --env it must appear verbatim.
# ---------------------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker env passthrough (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping the Docker --env leg"
  exit 0
fi
if ! e2e::ensure_docker_test_image; then
  e2e::section "docker env passthrough (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

# A workflow that marks presence/absence so the assertion is unambiguous even
# when the var is unset (empty return value would print no line).
e2e::file "env_token.jh" <<'EOF'
script token_impl = `echo "MY_TOKEN=[${MY_TOKEN:-<unset>}]"`
workflow default() {
  const t = run token_impl()
  return "${t}"
}
EOF

e2e::section "docker — non-allowlisted key crosses only with --env"

with_out="$(JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" jaiph run --env MY_TOKEN=s3cret "${TEST_DIR}/env_token.jh" 2>/dev/null)"
# assert_contains: full Docker stdout carries pull/status lines that vary; the
# workflow's return value is what we pin.
e2e::assert_contains "${with_out}" "MY_TOKEN=[s3cret]" "docker: --env forwards MY_TOKEN across the allowlist"

without_out="$(MY_TOKEN=s3cret JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" jaiph run "${TEST_DIR}/env_token.jh" 2>/dev/null)"
# assert_contains: same rationale; MY_TOKEN is set on the host but must NOT leak
# into the container without --env (fail-closed allowlist).
e2e::assert_contains "${without_out}" "MY_TOKEN=[<unset>]" "docker: MY_TOKEN stays unset without --env"
