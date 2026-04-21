#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_failure_parity"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Gate on Docker availability — skip gracefully when Docker is not installed.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker failure parity (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping Docker failure parity tests"
  exit 0
fi

# Build a local test image with jaiph installed from current source.
if ! e2e::ensure_docker_test_image; then
  e2e::section "docker failure parity (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

e2e::section "docker vs no-sandbox: same failure footer on failed step"

# Given: a workflow that always fails (no args provided → validate_name exits 1)
e2e::file "fail_parity.jh" <<'EOF'
script validate_name = ```
if [ -z "$1" ]; then
  echo "You didn't provide your name :(" >&2
  exit 1
fi
```

rule name_was_provided(name) {
  run validate_name(name)
}

workflow default(name) {
  ensure name_was_provided(name)
}
EOF

# When: run without Docker (no sandbox)
nosandbox_stderr="$(mktemp)"
rm -rf "${TEST_DIR}/runs_nosandbox"
if JAIPH_UNSAFE=true JAIPH_RUNS_DIR="${TEST_DIR}/runs_nosandbox" jaiph run "${TEST_DIR}/fail_parity.jh" 2>"${nosandbox_stderr}" >/dev/null; then
  cat "${nosandbox_stderr}" >&2
  rm -f "${nosandbox_stderr}"
  e2e::fail "no-sandbox: should have failed"
fi
nosandbox_err="$(cat "${nosandbox_stderr}")"
rm -f "${nosandbox_stderr}"

# When: run with Docker
docker_stderr="$(mktemp)"
rm -rf "${TEST_DIR}/runs_docker"
if JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" JAIPH_RUNS_DIR="${TEST_DIR}/runs_docker" jaiph run "${TEST_DIR}/fail_parity.jh" 2>"${docker_stderr}" >/dev/null; then
  cat "${docker_stderr}" >&2
  rm -f "${docker_stderr}"
  e2e::fail "docker: should have failed"
fi
docker_err="$(cat "${docker_stderr}")"
rm -f "${docker_stderr}"

# Then: both modes produce the same structural failure footer

# assert_contains: absolute paths differ between modes, so we check structural elements
e2e::assert_contains "${nosandbox_err}" "Logs:" "no-sandbox: failure footer includes Logs:"
e2e::assert_contains "${nosandbox_err}" "Summary:" "no-sandbox: failure footer includes Summary:"
e2e::assert_contains "${nosandbox_err}" "err:" "no-sandbox: failure footer includes err: path"
e2e::assert_contains "${nosandbox_err}" "Output of failed step:" "no-sandbox: failure footer includes step output header"
e2e::assert_contains "${nosandbox_err}" "You didn't provide your name :(" "no-sandbox: failure footer includes step stderr content"

e2e::assert_contains "${docker_err}" "Logs:" "docker: failure footer includes Logs:"
e2e::assert_contains "${docker_err}" "Summary:" "docker: failure footer includes Summary:"
e2e::assert_contains "${docker_err}" "err:" "docker: failure footer includes err: path"
e2e::assert_contains "${docker_err}" "Output of failed step:" "docker: failure footer includes step output header"
e2e::assert_contains "${docker_err}" "You didn't provide your name :(" "docker: failure footer includes step stderr content"

# Verify Docker paths point at the host filesystem (not container /jaiph/run)
# assert_contains: Docker Logs: path must be a host path, not a container path
e2e::assert_contains "${docker_err}" "${TEST_DIR}/runs_docker" "docker: Logs path points to host runs dir"

# Verify no container path leaks
if echo "${docker_err}" | grep -q '/jaiph/run/'; then
  printf 'docker stderr contains container path /jaiph/run/:\n%s\n' "${docker_err}" >&2
  e2e::fail "docker: failure footer must not contain container-internal paths"
fi
e2e::pass "docker: no container-internal /jaiph/run/ paths leaked"

# Verify artifact files actually exist at the paths shown in Docker footer
docker_run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_docker" "fail_parity.jh")"
docker_summary="${docker_run_dir}run_summary.jsonl"
e2e::assert_file_exists "${docker_summary}" "docker: run_summary.jsonl exists on host"

# Verify the .err file exists and contains the expected error
shopt -s nullglob
docker_err_files=( "${docker_run_dir}"*validate_name.err )
shopt -u nullglob
[[ ${#docker_err_files[@]} -ge 1 ]] || e2e::fail "docker: expected .err file for validate_name"
e2e::assert_equals "$(<"${docker_err_files[0]}")" "You didn't provide your name :(" "docker: .err file content matches"
