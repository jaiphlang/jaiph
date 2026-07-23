#!/usr/bin/env bash

# Contract: `trusted_envs` declares which host env keys a workflow's trusted
# `run` steps receive — no `--env` flag needed. Keys resolve from the pristine
# host env captured at process start (an explicit `--env KEY=VALUE` overrides
# the host value); a sub-workflow that does not declare a key never inherits
# it; `trusted_envs` in an imported module is ignored (with a warning); a
# missing declared key fails pre-flight with E_ENV_MISSING; reserved keys are
# rejected at parse time. In Docker, declared keys cross the sandbox boundary
# like `--env` pairs.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "trusted_envs"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Never inherit a real TR_TOKEN from the invoking shell.
unset TR_TOKEN || true

e2e::file "trusted_show.jh" <<'EOF'
config {
  trusted_envs = "TR_TOKEN"
}
script show_impl = `echo "TR_TOKEN=[${TR_TOKEN:-<unset>}]"`
workflow default() {
  const t = run show_impl()
  return "${t}"
}
EOF

e2e::section "host mode — declared key reaches the run step without --env"

host_out="$(TR_TOKEN=host-secret e2e::run "trusted_show.jh")"
e2e::expect_stdout "${host_out}" <<'EOF'

Jaiph: Running trusted_show.jh

workflow default
  ▸ script show_impl
  ✓ script show_impl (<time>)
✓ PASS workflow default (<time>)

TR_TOKEN=[host-secret]
EOF

e2e::section "host mode — --env KEY=VALUE overrides the host-snapshot value"

precedence_out="$(TR_TOKEN=host-secret e2e::run "trusted_show.jh" --env TR_TOKEN=cli-wins)"
e2e::expect_stdout "${precedence_out}" <<'EOF'

Jaiph: Running trusted_show.jh

workflow default
  ▸ script show_impl
  ✓ script show_impl (<time>)
✓ PASS workflow default (<time>)

TR_TOKEN=[cli-wins]
EOF

e2e::section "host mode — undeclared sub-workflow does not inherit the caller's key"

e2e::file "trusted_sub.jh" <<'EOF'
script main_show = `echo "MAIN=[${TR_TOKEN:-<unset>}]"`
script sub_show = `echo "SUB=[${TR_TOKEN:-<unset>}]"`
workflow sub() {
  const s = run sub_show()
  return "${s}"
}
workflow default() {
  config {
    trusted_envs = "TR_TOKEN"
  }
  const m = run main_show()
  const s = run sub()
  return "${m} ${s}"
}
EOF

sub_out="$(TR_TOKEN=host-secret e2e::run "trusted_sub.jh")"
e2e::expect_stdout "${sub_out}" <<'EOF'

Jaiph: Running trusted_sub.jh

workflow default
  ▸ script main_show
  ✓ script main_show (<time>)
  ▸ workflow sub
  ·   ▸ script sub_show
  ·   ✓ script sub_show (<time>)
  ✓ workflow sub (<time>)
✓ PASS workflow default (<time>)

MAIN=[host-secret] SUB=[<unset>]
EOF

e2e::section "host mode — trusted_envs in an imported module is ignored (warning)"

e2e::file "trusted_lib.jh" <<'EOF'
config {
  trusted_envs = "TR_TOKEN"
}
script lib_show = `echo "LIB=[${TR_TOKEN:-<unset>}]"`
workflow grab() {
  const g = run lib_show()
  return "${g}"
}
EOF

e2e::file "trusted_entry.jh" <<'EOF'
import "trusted_lib.jh" as lib
workflow default() {
  const g = run lib.grab()
  return "${g}"
}
EOF

import_out="$(TR_TOKEN=host-secret e2e::run "trusted_entry.jh" 2>"${TEST_DIR}/import.stderr")"
e2e::expect_stdout "${import_out}" <<'EOF'

Jaiph: Running trusted_entry.jh

workflow default
  ▸ workflow grab
  ·   ▸ script lib_show
  ·   ✓ script lib_show (<time>)
  ✓ workflow grab (<time>)
✓ PASS workflow default (<time>)

LIB=[<unset>]
EOF
# assert_contains: the warning line carries an absolute module path that varies
# per checkout, so full stderr equality is not feasible.
e2e::assert_contains "$(<"${TEST_DIR}/import.stderr")" \
  "trusted_envs declared in imported module" \
  "trusted_envs: imported-module declaration warns on stderr"

e2e::section "missing declared key fails pre-flight with E_ENV_MISSING"

missing_out=""
if missing_out="$(e2e::run "trusted_show.jh" 2>&1)"; then
  e2e::fail "trusted_envs: run should abort when the declared key is unset on the host"
fi
# assert_contains: the error names the varying key and entry path; the run
# never starts, so there is no banner/tree to compare in full.
e2e::assert_contains "${missing_out}" "E_ENV_MISSING" "trusted_envs: missing declared key aborts with E_ENV_MISSING"
e2e::assert_contains "${missing_out}" "TR_TOKEN" "trusted_envs: E_ENV_MISSING names the missing key"

e2e::section "reserved keys in trusted_envs are rejected at parse time"

e2e::file "trusted_reserved.jh" <<'EOF'
config {
  trusted_envs = "JAIPH_WORKSPACE"
}
workflow default() {
  log "never runs"
}
EOF

reserved_out=""
if reserved_out="$(e2e::run "trusted_reserved.jh" 2>&1)"; then
  e2e::fail "trusted_envs: reserved key should be rejected"
fi
# assert_contains: only the reserved-key rejection is contract; the parse-error
# prefix carries a varying absolute path.
e2e::assert_contains "${reserved_out}" 'trusted_envs cannot declare reserved key "JAIPH_WORKSPACE"' \
  "trusted_envs: reserved key rejected"

# ---------------------------------------------------------------------------
# Docker leg: a declared key crosses the sandbox boundary without --env.
# TR_TOKEN is not on ENV_ALLOW_PREFIXES, so only the trusted_envs declaration
# (threaded through the same explicit -e channel as --env) can carry it.
# ---------------------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker trusted_envs (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping the Docker trusted_envs leg"
  exit 0
fi
if ! e2e::ensure_docker_test_image; then
  e2e::section "docker trusted_envs (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

e2e::section "docker — declared key crosses the sandbox boundary without --env"

docker_out="$(TR_TOKEN=host-secret JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" jaiph run "${TEST_DIR}/trusted_show.jh" 2>/dev/null)"
# assert_contains: full Docker stdout carries pull/status lines that vary; the
# workflow's return value is what we pin.
e2e::assert_contains "${docker_out}" "TR_TOKEN=[host-secret]" "docker: trusted_envs forwards the declared key across the allowlist"

docker_sub_out="$(TR_TOKEN=host-secret JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" jaiph run "${TEST_DIR}/trusted_sub.jh" 2>/dev/null)"
# assert_contains: same rationale; inside the container the undeclared
# sub-workflow must still not see the key.
e2e::assert_contains "${docker_sub_out}" "MAIN=[host-secret] SUB=[<unset>]" "docker: undeclared sub-workflow stays scrubbed inside the sandbox"
