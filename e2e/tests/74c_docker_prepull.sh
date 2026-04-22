#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_prepull"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Gate on Docker availability — skip gracefully when Docker is not installed.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker prepull (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping Docker prepull tests"
  exit 0
fi

# Build a local test image with jaiph installed from current source.
if ! e2e::ensure_docker_test_image; then
  e2e::section "docker prepull (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

# ---------------------------------------------------------------------------
# Pre-pull: banner appears only after image preparation
# ---------------------------------------------------------------------------

e2e::section "docker prepull — banner after image prep, pulling line on stderr"

e2e::file "prepull_check.jh" <<'EOF'
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

# When: run with Docker enabled — capture stdout (banner) and stderr separately.
stdout_file="${TEST_DIR}/prepull_stdout.txt"
stderr_file="${TEST_DIR}/prepull_stderr.txt"

timeout 60 bash -c "JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE='${E2E_DOCKER_TEST_IMAGE}' jaiph run '${TEST_DIR}/prepull_check.jh'" \
  >"${stdout_file}" 2>"${stderr_file}" || true

# Then: stdout (banner) must contain the "running" line.
stdout_content="$(<"${stdout_file}")"
# assert_contains: banner includes workflow name and running marker; exact format varies by TTY/colour
e2e::assert_contains "${stdout_content}" "workflow default" "docker prepull: banner appears in stdout"

# Then: stderr must NOT contain Docker's native pull progress (layer hashes, progress bars).
stderr_content="$(<"${stderr_file}")"
if echo "${stderr_content}" | grep -qiE 'Pulling from|Downloading|Extracting|[0-9a-f]{12}:'; then
  e2e::fail "docker prepull: Docker native pull progress leaked to stderr"
fi
e2e::pass "docker prepull: no Docker native pull progress in output"

# ---------------------------------------------------------------------------
# Cold pull: exactly one "pulling image" status line on stderr
# ---------------------------------------------------------------------------

e2e::section "docker prepull — cold pull status line"

# Use a small image that is unlikely to be cached: alpine with a specific tag.
# Remove it first to force a cold pull.
COLD_IMAGE="alpine:3.20"
docker rmi "${COLD_IMAGE}" >/dev/null 2>&1 || true

e2e::file "cold_pull.jh" <<'EOF'
script hello_impl = ```
echo "hello"
```
rule hello() {
  run hello_impl()
}

workflow default() {
  ensure hello()
}
EOF

# Run with the cold image — this will fail (alpine has no jaiph) but we only
# care about the pull status line, not workflow success.
cold_stderr="${TEST_DIR}/cold_stderr.txt"
timeout 120 bash -c "JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE='${COLD_IMAGE}' jaiph run '${TEST_DIR}/cold_pull.jh'" \
  >/dev/null 2>"${cold_stderr}" || true

cold_stderr_content="$(<"${cold_stderr}")"

# assert_contains: the pulling status line includes the image name; exact wording is our contract
e2e::assert_contains "${cold_stderr_content}" "pulling image ${COLD_IMAGE}" "docker prepull: pulling status line on cold pull"

# Exactly one "pulling image" line.
pull_count="$(grep -c "pulling image" "${cold_stderr}" || true)"
e2e::assert_equals "${pull_count}" "1" "docker prepull: exactly one pulling status line"

e2e::pass "docker prepull: cold pull status line correct"
