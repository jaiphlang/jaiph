#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_dockerfile_detection"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Gate on Docker availability — skip gracefully when Docker is not installed.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker dockerfile detection (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping Dockerfile detection tests"
  exit 0
fi

# Build the E2E test image (used for explicit-image tests below).
if ! e2e::ensure_docker_test_image; then
  e2e::section "docker dockerfile detection (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

e2e::section "docker — invalid .jaiph/Dockerfile is not built on run"

# Given: a syntactically invalid .jaiph/Dockerfile. If `jaiph run` tried to build it,
# the run would fail with E_DOCKER_BUILD. The driver must use the default GHCR image instead.
mkdir -p "${TEST_DIR}/.jaiph"
printf '%s\n' 'THIS IS NOT A VALID DOCKERFILE' > "${TEST_DIR}/.jaiph/Dockerfile"

e2e::file "dockerfile_ignored.jh" <<'EOF'
script ping_impl = ```
echo "pulled default image ok"
```
rule ping() {
  run ping_impl()
}

workflow default() {
  ensure ping()
}
EOF

# When: Docker enabled, implicit default image (pull ghcr.io/jaiphlang/jaiph-runtime:<version>)
if ! JAIPH_DOCKER_ENABLED=true jaiph run "${TEST_DIR}/dockerfile_ignored.jh" >/dev/null 2>&1; then
  JAIPH_DOCKER_ENABLED=true jaiph run "${TEST_DIR}/dockerfile_ignored.jh" || true
  e2e::fail "docker: run should use pulled default image, not build broken .jaiph/Dockerfile"
fi

run_dir="$(e2e::run_dir "dockerfile_ignored.jh")"
e2e::expect_run_file "dockerfile_ignored.jh" "000003-script__ping_impl.out" "pulled default image ok"
e2e::pass "docker: broken .jaiph/Dockerfile is ignored; default runtime image is used"

e2e::section "docker — explicit image with present .jaiph/Dockerfile"

# Given: same workspace with invalid .jaiph/Dockerfile, explicit image set
e2e::file "dockerfile_skip.jh" <<'EOF'
script check_no_marker_impl = ```
if test -f /jaiph-runtime-marker; then
  echo "marker unexpectedly found"
  exit 1
fi
echo "no marker"
```
rule check_no_marker() {
  run check_no_marker_impl()
}

workflow default() {
  ensure check_no_marker()
}
EOF

# When: run with Docker enabled AND explicit image (should skip Dockerfile)
JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" jaiph run "${TEST_DIR}/dockerfile_skip.jh" >/dev/null 2>&1

# Then: the marker file should NOT exist (E2E test image, not custom build)
e2e::expect_run_file "dockerfile_skip.jh" "000003-script__check_no_marker_impl.out" "no marker"
e2e::pass "docker: explicit image used; .jaiph/Dockerfile not built"

e2e::section "docker — workspace without .jaiph/Dockerfile uses configured image"

# Given: a separate test dir without .jaiph/Dockerfile, using the E2E test image
fallback_dir="$(mktemp -d "${JAIPH_E2E_WORK_DIR}/docker_fallback.XXXXXX")"
cat > "${fallback_dir}/fallback.jh" <<'EOF'
script greet_impl = ```
echo "hello fallback"
```
rule greet() {
  run greet_impl()
}

workflow default() {
  ensure greet()
}
EOF

# When: run with Docker enabled and explicit E2E image (no .jaiph/Dockerfile present)
JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" JAIPH_WORKSPACE="${fallback_dir}" jaiph run "${fallback_dir}/fallback.jh" >/dev/null 2>&1

# Then: should succeed using the configured image
fallback_run_dir="$(e2e::run_dir_at "${fallback_dir}/.jaiph/runs" "fallback.jh")"
fallback_summary="${fallback_run_dir}run_summary.jsonl"
e2e::assert_file_exists "${fallback_summary}" "docker: fallback run_summary.jsonl exists"
e2e::pass "docker: falls back to configured image without .jaiph/Dockerfile"

e2e::section "docker dockerfile detection — agent env vars are forwarded"

# Given: a workflow that checks visibility of agent env vars
e2e::file "envforward.jh" <<'EOF'
script check_env_impl = ```
echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-unset}"
echo "CURSOR_SESSION=${CURSOR_SESSION:-unset}"
```
rule check_env() {
  run check_env_impl()
}

workflow default() {
  ensure check_env()
}
EOF

# When: run with agent env vars set on host
JAIPH_DOCKER_ENABLED=true \
  JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" \
  ANTHROPIC_API_KEY="test-key-123" \
  CURSOR_SESSION="test-session-456" \
  jaiph run "${TEST_DIR}/envforward.jh" >/dev/null 2>&1

# Then: agent env vars are forwarded to the container (ANTHROPIC_*, CURSOR_* prefixes)
run_dir="$(e2e::run_dir "envforward.jh")"
out_content="$(<"${run_dir}000003-script__check_env_impl.out")"
# assert_contains: script .out may include additional env vars or runtime-injected lines
e2e::assert_contains "${out_content}" "ANTHROPIC_API_KEY=test-key-123" "docker: ANTHROPIC_API_KEY forwarded"
# assert_contains: script .out may include additional env vars or runtime-injected lines
e2e::assert_contains "${out_content}" "CURSOR_SESSION=test-session-456" "docker: CURSOR_SESSION forwarded"

rm -rf "${fallback_dir}"
