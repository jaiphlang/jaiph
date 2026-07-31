#!/usr/bin/env bash
#
# Docker network/image are host-controlled (finding M-6). A repo- or model-
# supplied entry file must not be able to gut the sandbox it runs in:
#   - `config { runtime { docker_network = "host" } }`      → E_DOCKER_NETWORK_HOST_ONLY
#   - `docker_network = "container:*"` / `"ns:*"`            → E_DOCKER_NETWORK_HOST_ONLY
#   - `config { runtime { docker_image = "…" } }`           → E_DOCKER_IMAGE_HOST_ONLY
# The rejection fires at config resolution (before Docker is probed), so these
# legs need no Docker daemon. The operator env override (JAIPH_DOCKER_NETWORK /
# JAIPH_DOCKER_IMAGE) is trusted and still takes effect — that leg is gated on
# Docker availability.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_network_host_control"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Local negative-substring assertion (no shared harness helper for this).
assert_absent() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    printf "Expected output to NOT contain: %s\n" "${needle}" >&2
    printf "Output was:\n%s\n" "${haystack}" >&2
    e2e::fail "${label}"
  fi
  e2e::pass "${label}"
}

# Run `jaiph run` with Docker enabled and capture combined output + exit code.
# JAIPH_DOCKER_ENABLED=true makes Docker the active sandbox so the host-control
# checks engage; the rejection aborts before the daemon is contacted.
run_docker_enabled() {
  local file="$1"
  shift
  set +e
  RUN_OUT="$(cd "${TEST_DIR}" && env JAIPH_DOCKER_ENABLED=true "$@" jaiph run "${file}" 2>&1)"
  RUN_CODE=$?
  set -e
}

# ---------------------------------------------------------------------------
# AC1: file-declared docker_network = "host" is rejected before launch
# ---------------------------------------------------------------------------
e2e::section "file-declared docker_network host is rejected (E_DOCKER_NETWORK_HOST_ONLY)"

e2e::file "net_host.jh" <<'EOF'
config {
  runtime.docker_network = "host"
}
workflow default() {
  log "should-not-run"
}
EOF

run_docker_enabled "${TEST_DIR}/net_host.jh"
e2e::assert_equals "${RUN_CODE}" "1" "docker_network host exits 1"
# Substring: stderr also carries a credential/preflight preamble that is not
# pinned here; the actionable error code is the contract under test.
e2e::assert_contains "${RUN_OUT}" "E_DOCKER_NETWORK_HOST_ONLY" "host network rejected with actionable code"
assert_absent "${RUN_OUT}" "should-not-run" "workflow body never ran (aborted before launch)"

# ---------------------------------------------------------------------------
# AC2: namespace-joining networks (container:* / ns:*) are rejected
# ---------------------------------------------------------------------------
e2e::section "file-declared docker_network container:* / ns:* is rejected"

e2e::file "net_container.jh" <<'EOF'
config {
  runtime.docker_network = "container:other"
}
workflow default() {
  log "should-not-run"
}
EOF

run_docker_enabled "${TEST_DIR}/net_container.jh"
e2e::assert_equals "${RUN_CODE}" "1" "docker_network container:* exits 1"
e2e::assert_contains "${RUN_OUT}" "E_DOCKER_NETWORK_HOST_ONLY" "container:* network rejected"

e2e::file "net_ns.jh" <<'EOF'
config {
  runtime.docker_network = "ns:/proc/1/ns/net"
}
workflow default() {
  log "should-not-run"
}
EOF

run_docker_enabled "${TEST_DIR}/net_ns.jh"
e2e::assert_equals "${RUN_CODE}" "1" "docker_network ns:* exits 1"
e2e::assert_contains "${RUN_OUT}" "E_DOCKER_NETWORK_HOST_ONLY" "ns:* network rejected"

# ---------------------------------------------------------------------------
# AC3: file-declared docker_image is rejected (host-controlled)
# ---------------------------------------------------------------------------
e2e::section "file-declared docker_image is rejected (E_DOCKER_IMAGE_HOST_ONLY)"

e2e::file "img_file.jh" <<'EOF'
config {
  runtime.docker_image = "ubuntu:24.04"
}
workflow default() {
  log "should-not-run"
}
EOF

run_docker_enabled "${TEST_DIR}/img_file.jh"
e2e::assert_equals "${RUN_CODE}" "1" "docker_image from file exits 1"
e2e::assert_contains "${RUN_OUT}" "E_DOCKER_IMAGE_HOST_ONLY" "file-declared image rejected with actionable code"
assert_absent "${RUN_OUT}" "should-not-run" "workflow body never ran (aborted before launch)"

# ---------------------------------------------------------------------------
# AC4: operator-supplied JAIPH_DOCKER_NETWORK / JAIPH_DOCKER_IMAGE take effect,
# overriding the file's host-controlled values without rejection. Gated on
# Docker availability (this leg launches a real container).
# ---------------------------------------------------------------------------
e2e::section "operator env override of network/image takes effect"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::skip "Docker unavailable — operator-override leg skipped"
  exit 0
fi
if ! e2e::ensure_docker_test_image; then
  e2e::skip "Could not build local Docker test image — operator-override leg skipped"
  exit 0
fi

# The file declares docker_network = "host" (which would otherwise be rejected);
# the operator overrides it to the safe `none` via env, and pins the image via
# env. The run must proceed to completion — proving the trusted host-controlled
# path still works and overrides the file value.
override_out="$(cd "${TEST_DIR}" \
  && JAIPH_DOCKER_ENABLED=true \
     JAIPH_DOCKER_NETWORK=none \
     JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" \
     jaiph run "${TEST_DIR}/net_host.jh" 2>&1)"
# Substring: the banner/footer carry non-deterministic timing + paths; the
# workflow's own output and the absence of the rejection code are the contract.
e2e::assert_contains "${override_out}" "should-not-run" "operator override lets the run proceed to completion"
assert_absent "${override_out}" "E_DOCKER_NETWORK_HOST_ONLY" "operator env override bypasses the file-value gate"
