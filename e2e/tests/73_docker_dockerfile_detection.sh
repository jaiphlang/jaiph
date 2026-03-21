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
FROM ubuntu:24.04
RUN touch /jaiph-runtime-marker
DOCKERFILE

e2e::file "dockerfile_detect.jh" <<'EOF'
rule check_marker {
  test -f /jaiph-runtime-marker && echo "marker found"
}

workflow default {
  ensure check_marker
}
EOF

# When: run with Docker enabled and no explicit docker_image
JAIPH_DOCKER_ENABLED=true jaiph run "${TEST_DIR}/dockerfile_detect.jh" >/dev/null 2>&1

# Then: the workflow should succeed (marker file present = custom image was used)
run_dir="$(e2e::run_dir "dockerfile_detect.jh")"
e2e::expect_run_file "dockerfile_detect.jh" "000002-dockerfile_detect__check_marker.out" "marker found"
e2e::pass "docker: .jaiph/Dockerfile detected and image built"

e2e::section "docker dockerfile detection — explicit image skips Dockerfile"

# Given: same workspace with .jaiph/Dockerfile, but explicit image set
e2e::file "dockerfile_skip.jh" <<'EOF'
rule check_no_marker {
  if test -f /jaiph-runtime-marker; then
    echo "marker unexpectedly found"
    exit 1
  fi
  echo "no marker"
}

workflow default {
  ensure check_no_marker
}
EOF

# When: run with Docker enabled AND explicit image (should skip Dockerfile)
JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE=ubuntu:24.04 jaiph run "${TEST_DIR}/dockerfile_skip.jh" >/dev/null 2>&1

# Then: the marker file should NOT exist (standard ubuntu image, not custom)
e2e::expect_run_file "dockerfile_skip.jh" "000002-dockerfile_skip__check_no_marker.out" "no marker"
e2e::pass "docker: explicit image skips .jaiph/Dockerfile"

e2e::section "docker dockerfile detection — fallback without Dockerfile"

# Given: a separate test dir without .jaiph/Dockerfile
fallback_dir="$(mktemp -d "${JAIPH_E2E_WORK_DIR}/docker_fallback.XXXXXX")"
cat > "${fallback_dir}/fallback.jh" <<'EOF'
rule greet {
  echo "hello fallback"
}

workflow default {
  ensure greet
}
EOF

# When: run with Docker enabled but no .jaiph/Dockerfile present
JAIPH_DOCKER_ENABLED=true JAIPH_WORKSPACE="${fallback_dir}" jaiph run "${fallback_dir}/fallback.jh" >/dev/null 2>&1

# Then: should use default ubuntu:24.04 and succeed
fallback_run_dir="$(e2e::run_dir_at "${fallback_dir}/.jaiph/runs" "fallback.jh")"
fallback_summary="${fallback_run_dir}run_summary.jsonl"
e2e::assert_file_exists "${fallback_summary}" "docker: fallback run_summary.jsonl exists"
e2e::pass "docker: falls back to ubuntu:24.04 without .jaiph/Dockerfile"

e2e::section "docker dockerfile detection — env var forwarding"

# Given: a workflow that checks for forwarded env vars
e2e::file "envforward.jh" <<'EOF'
rule check_env {
  echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-unset}"
  echo "CURSOR_SESSION=${CURSOR_SESSION:-unset}"
}

workflow default {
  ensure check_env
}
EOF

# When: run with agent env vars set
JAIPH_DOCKER_ENABLED=true \
  ANTHROPIC_API_KEY="test-key-123" \
  CURSOR_SESSION="test-session-456" \
  jaiph run "${TEST_DIR}/envforward.jh" >/dev/null 2>&1

# Then: env vars should be visible inside the container
run_dir="$(e2e::run_dir "envforward.jh")"
out_content="$(<"${run_dir}000002-envforward__check_env.out")"
e2e::assert_contains "${out_content}" "ANTHROPIC_API_KEY=test-key-123" "docker: ANTHROPIC_API_KEY forwarded"
e2e::assert_contains "${out_content}" "CURSOR_SESSION=test-session-456" "docker: CURSOR_SESSION forwarded"

rm -rf "${fallback_dir}"
