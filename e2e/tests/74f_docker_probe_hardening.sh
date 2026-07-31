#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"

# Derived probe-test image built below; removed on exit alongside temp dirs.
PROBE_IMAGE="jaiph-e2e-probe-profile:local"
cleanup_probe() {
  docker rmi -f "${PROBE_IMAGE}" >/dev/null 2>&1 || true
  e2e::cleanup
}
trap cleanup_probe EXIT

e2e::prepare_test_env "docker_probe_hardening"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Gate on Docker availability — skip gracefully when Docker is not installed.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker probe hardening (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping Docker probe hardening tests"
  exit 0
fi

if ! e2e::ensure_docker_test_image; then
  e2e::section "docker probe hardening (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

# ---------------------------------------------------------------------------
# Profile scripts baked into the probed image must NOT be sourced by the probe.
#
# The jaiph-presence probe (imageHasJaiph) runs a workflow-selected image before
# the real run. Historically it used a login shell (`sh -lc`), which sources
# /etc/profile and /etc/profile.d/* — image-controlled code executed at higher
# privilege than the hardened run (M-8). Build an image whose profile.d script
# aborts any login shell (`exit 47`): a login-shell probe would fail and the run
# would abort with E_DOCKER_NO_JAIPH. The hardened non-login probe (`sh -c`)
# never sources it, so the presence check passes and the workflow runs.
# ---------------------------------------------------------------------------

e2e::section "docker probe hardening — image profile scripts are not sourced by the probe"

# Derive an image from the local runtime test image, adding a profile.d script
# that breaks any login shell. Needs root to write under /etc; restore the
# non-root default user afterwards so the image behaves like the real runtime.
build_ctx="${TEST_DIR}/probe_ctx"
mkdir -p "${build_ctx}"
cat >"${build_ctx}/Dockerfile" <<EOF
FROM ${E2E_DOCKER_TEST_IMAGE}
USER root
RUN printf '%s\n' 'echo PROFILE_SOURCED_BY_PROBE' 'exit 47' > /etc/profile.d/zz-boom.sh \\
  && chmod 0644 /etc/profile.d/zz-boom.sh
USER jaiph
EOF

if ! docker build -t "${PROBE_IMAGE}" -f "${build_ctx}/Dockerfile" "${build_ctx}" >/dev/null 2>&1; then
  e2e::skip "Could not build derived probe-test image"
  exit 0
fi

e2e::file "probe_hardening.jh" <<'EOF'
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

stdout_file="${TEST_DIR}/probe_stdout.txt"
stderr_file="${TEST_DIR}/probe_stderr.txt"

# When: run the workflow against the profile-booby-trapped image.
timeout 120 bash -c "JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE='${PROBE_IMAGE}' jaiph run '${TEST_DIR}/probe_hardening.jh'" \
  >"${stdout_file}" 2>"${stderr_file}" || true

stdout_content="$(<"${stdout_file}")"
stderr_content="$(<"${stderr_file}")"

# Then: the probe must NOT have failed — a login-shell probe would have aborted
# the presence check with E_DOCKER_NO_JAIPH.
if echo "${stderr_content}" | grep -q "E_DOCKER_NO_JAIPH"; then
  printf "stderr was:\n%s\n" "${stderr_content}" >&2
  e2e::fail "docker probe hardening: probe failed on image with profile.d script (login shell regression)"
fi

# Then: the workflow ran to completion — the hardened probe passed.
# assert_contains: banner format varies by TTY/colour; the run marker is stable.
e2e::assert_contains "${stdout_content}" "workflow default" \
  "docker probe hardening: workflow runs when probed image has profile.d scripts"

e2e::pass "docker probe hardening: profile scripts not sourced by the presence probe"
