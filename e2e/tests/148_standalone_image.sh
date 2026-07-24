#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "standalone_image"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "standalone runtime image (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping standalone image smoke test"
  exit 0
fi

if ! e2e::ensure_docker_test_image; then
  e2e::section "standalone runtime image (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

e2e::section "standalone image — put credentials + jaiph files and run it"

# A workflow that returns a value. No prompt/agent step, so no credentials are
# needed; the point is that `jaiph run` works with no host orchestrator and no
# Docker daemon inside the container, purely off the image's baked JAIPH_UNSAFE.
e2e::file "hello.jh" <<'EOF'
workflow default() {
  return "standalone-ok"
}
EOF

# Run the image standalone, exactly as the docs one-shot does. We do NOT pass
# -e JAIPH_UNSAFE: host mode must come from the ENV baked into the image. There
# is no Docker daemon inside the container, so if the baked ENV were missing the
# inner run would abort with E_DOCKER_NOT_FOUND instead of exiting 0.
# --user matches the host UID so the bind-mounted run artifacts are writable and
# readable back by the test harness.
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "${TEST_DIR}":/work -w /work \
  "${E2E_DOCKER_TEST_IMAGE}" \
  jaiph run hello.jh >/dev/null

# The return value must round-trip to the durable return_value.txt artifact.
return_file="$(find "${TEST_DIR}/.jaiph/runs" -name return_value.txt | head -n 1)"
if [[ -z "${return_file}" ]]; then
  echo "FAIL: no return_value.txt produced by standalone run" >&2
  exit 1
fi
return_value="$(cat "${return_file}")"
e2e::assert_equals "${return_value}" "standalone-ok" "standalone return value round-trip"
