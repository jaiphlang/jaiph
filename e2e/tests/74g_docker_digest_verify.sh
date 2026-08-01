#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_digest_verify"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Gate on Docker availability — skip gracefully when Docker is not installed.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker digest verify (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping Docker digest verification tests"
  exit 0
fi

# Build a local test image with jaiph installed from current source.
if ! e2e::ensure_docker_test_image; then
  e2e::section "docker digest verify (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

# ---------------------------------------------------------------------------
# Digest pinning + fail-closed verification (finding M-6).
#
# The sandbox image is the boundary between untrusted workflows and the host.
# A run must resolve/verify the image by its expected manifest digest on every
# run (including cache hits). A locally-cached image whose digest does not match
# the pinned digest — e.g. a re-pointed tag or a poisoned local cache — must
# fail closed before the container is spawned. JAIPH_DOCKER_IMAGE_DIGEST pins
# the expected digest for the operator-selected image.
# ---------------------------------------------------------------------------

e2e::file "digest_check.jh" <<'EOF'
script greet_impl = ```
echo "hello from container"
```
rule greet() {
  run greet_impl()
}

workflow default() {
  ensure greet()
}
EOF

# The locally-built test image carries no registry (RepoDigests) entry, so ANY
# pinned digest is a mismatch — this models the poisoned-local-cache case where
# the tag resolves to content whose digest is not the one we trust.
BOGUS_DIGEST="sha256:$(printf 'e%.0s' {1..64})"

# --- Case 1: pinned digest mismatch → fail closed --------------------------
e2e::section "docker digest verify — mismatched digest fails closed"

mismatch_stdout="${TEST_DIR}/mismatch_stdout.txt"
mismatch_stderr="${TEST_DIR}/mismatch_stderr.txt"

set +e
timeout 120 bash -c "JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE='${E2E_DOCKER_TEST_IMAGE}' JAIPH_DOCKER_IMAGE_DIGEST='${BOGUS_DIGEST}' jaiph run '${TEST_DIR}/digest_check.jh'" \
  >"${mismatch_stdout}" 2>"${mismatch_stderr}"
mismatch_rc=$?
set -e

mismatch_stderr_content="$(<"${mismatch_stderr}")"
mismatch_stdout_content="$(<"${mismatch_stdout}")"

if [[ "${mismatch_rc}" -eq 0 ]]; then
  printf "stdout was:\n%s\nstderr was:\n%s\n" "${mismatch_stdout_content}" "${mismatch_stderr_content}" >&2
  e2e::fail "docker digest verify: run with a mismatched pinned digest must not succeed"
fi

# assert_contains: the failure footer/banner formatting varies by TTY/colour;
# the E_DOCKER_DIGEST_MISMATCH code and the recovery hint are the stable parts.
e2e::assert_contains "${mismatch_stderr_content}" "E_DOCKER_DIGEST_MISMATCH" \
  "docker digest verify: mismatched cached image fails closed with E_DOCKER_DIGEST_MISMATCH"
e2e::assert_contains "${mismatch_stderr_content}" "docker pull " \
  "docker digest verify: error tells the operator how to re-pull the pinned image"
e2e::assert_contains "${mismatch_stderr_content}" "@${BOGUS_DIGEST}" \
  "docker digest verify: recovery hint names the pinned digest to re-pull"

# The workflow body must never have executed — the gate is before the spawn.
if echo "${mismatch_stdout_content}" | grep -q "hello from container"; then
  e2e::fail "docker digest verify: workflow ran despite a digest mismatch (gate must precede spawn)"
fi

# --- Case 2: no pinned digest → run proceeds normally ----------------------
e2e::section "docker digest verify — unpinned custom image proceeds"

ok_stdout="${TEST_DIR}/ok_stdout.txt"
ok_stderr="${TEST_DIR}/ok_stderr.txt"

# Same image, same cache entry, no digest pin: a custom operator image with no
# pin is not digest-enforced, so the run proceeds (control for Case 1 — proves
# the failure is the digest gate, not the image itself).
timeout 120 bash -c "JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE='${E2E_DOCKER_TEST_IMAGE}' jaiph run '${TEST_DIR}/digest_check.jh'" \
  >"${ok_stdout}" 2>"${ok_stderr}" || {
    printf "stderr was:\n%s\n" "$(<"${ok_stderr}")" >&2
    e2e::fail "docker digest verify: unpinned run should succeed"
  }

# The run already asserted exit 0 above; confirm the workflow actually executed
# inside the container (not just that the CLI started).
# assert_contains: the progress tree's exact glyphs/colour vary by TTY; the
# workflow and script step names are the stable markers.
ok_stdout_content="$(<"${ok_stdout}")"
e2e::assert_contains "${ok_stdout_content}" "workflow default" \
  "docker digest verify: unpinned custom image runs the workflow"
e2e::assert_contains "${ok_stdout_content}" "script greet_impl" \
  "docker digest verify: unpinned run reaches the container script step"

e2e::pass "docker digest verify: pinned-digest mismatch fails closed; unpinned run proceeds"
