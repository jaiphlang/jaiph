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

e2e::section "docker dockerfile detection — custom Dockerfile builds and runs"

# Given: a .jaiph/Dockerfile that produces a minimal image with a marker file
mkdir -p "${TEST_DIR}/.jaiph"
cat > "${TEST_DIR}/.jaiph/Dockerfile" <<'DOCKERFILE'
FROM node:20-bookworm
RUN touch /jaiph-runtime-marker
DOCKERFILE

e2e::file "dockerfile_detect.jh" <<'EOF'
script check_marker_impl() {
  test -f /jaiph-runtime-marker && echo "marker found"
}
rule check_marker {
  run check_marker_impl
}

workflow default {
  ensure check_marker
}
EOF

# When: run with Docker enabled and no explicit docker_image
JAIPH_DOCKER_ENABLED=true jaiph run "${TEST_DIR}/dockerfile_detect.jh" >/dev/null 2>&1

# Then: the workflow should succeed (marker file present = custom image was used)
run_dir="$(e2e::run_dir "dockerfile_detect.jh")"
e2e::expect_run_file "dockerfile_detect.jh" "000003-script__check_marker_impl.out" "marker found"
e2e::pass "docker: .jaiph/Dockerfile detected and image built"

e2e::section "docker dockerfile detection — explicit image skips Dockerfile"

# Given: same workspace with .jaiph/Dockerfile, but explicit image set
e2e::file "dockerfile_skip.jh" <<'EOF'
script check_no_marker_impl() {
  if test -f /jaiph-runtime-marker; then
    echo "marker unexpectedly found"
    exit 1
  fi
  echo "no marker"
}
rule check_no_marker {
  run check_no_marker_impl
}

workflow default {
  ensure check_no_marker
}
EOF

# When: run with Docker enabled AND explicit image (should skip Dockerfile)
JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE=node:20-bookworm jaiph run "${TEST_DIR}/dockerfile_skip.jh" >/dev/null 2>&1

# Then: the marker file should NOT exist (stock pulled image, not custom build)
e2e::expect_run_file "dockerfile_skip.jh" "000003-script__check_no_marker_impl.out" "no marker"
e2e::pass "docker: explicit image skips .jaiph/Dockerfile"

e2e::section "docker dockerfile detection — fallback without Dockerfile"

# Given: a separate test dir without .jaiph/Dockerfile
fallback_dir="$(mktemp -d "${JAIPH_E2E_WORK_DIR}/docker_fallback.XXXXXX")"
cat > "${fallback_dir}/fallback.jh" <<'EOF'
script greet_impl() {
  echo "hello fallback"
}
rule greet {
  run greet_impl
}

workflow default {
  ensure greet
}
EOF

# When: run with Docker enabled but no .jaiph/Dockerfile present
JAIPH_DOCKER_ENABLED=true JAIPH_WORKSPACE="${fallback_dir}" jaiph run "${fallback_dir}/fallback.jh" >/dev/null 2>&1

# Then: should use default Node image (bash + node for JS kernel) and succeed
fallback_run_dir="$(e2e::run_dir_at "${fallback_dir}/.jaiph/runs" "fallback.jh")"
fallback_summary="${fallback_run_dir}run_summary.jsonl"
e2e::assert_file_exists "${fallback_summary}" "docker: fallback run_summary.jsonl exists"
e2e::pass "docker: falls back to default image without .jaiph/Dockerfile"

e2e::section "docker dockerfile detection — agent env vars are forwarded"

# Given: a workflow that checks visibility of agent env vars
e2e::file "envforward.jh" <<'EOF'
script check_env_impl() {
  echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-unset}"
  echo "CURSOR_SESSION=${CURSOR_SESSION:-unset}"
}
rule check_env {
  run check_env_impl
}

workflow default {
  ensure check_env
}
EOF

# When: run with agent env vars set on host
JAIPH_DOCKER_ENABLED=true \
  ANTHROPIC_API_KEY="test-key-123" \
  CURSOR_SESSION="test-session-456" \
  jaiph run "${TEST_DIR}/envforward.jh" >/dev/null 2>&1

# Then: agent env vars are forwarded to the container (ANTHROPIC_*, CURSOR_* prefixes)
run_dir="$(e2e::run_dir "envforward.jh")"
out_content="$(<"${run_dir}000003-script__check_env_impl.out")"
e2e::assert_contains "${out_content}" "ANTHROPIC_API_KEY=test-key-123" "docker: ANTHROPIC_API_KEY forwarded"
e2e::assert_contains "${out_content}" "CURSOR_SESSION=test-session-456" "docker: CURSOR_SESSION forwarded"

rm -rf "${fallback_dir}"
