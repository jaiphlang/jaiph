#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_toolchain"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker toolchain (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping Docker toolchain tests"
  exit 0
fi

if ! e2e::ensure_docker_test_image; then
  e2e::section "docker toolchain (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

e2e::section "docker toolchain — daily coding tools available in sandbox"

e2e::file "docker_toolchain.jh" <<'EOF'
script check_toolchain = ```
set -euo pipefail
for cmd in \
  pnpm yarn bun gh uv go java javac mvn gradle \
  rustc cargo cmake git-lfs yq pipx protoc kubectl aws just task \
  sqlite3 shellcheck git jq rg curl python3 node npm; do
  command -v "${cmd}" >/dev/null
done
test -n "${JAVA_HOME:-}"
echo "toolchain ok"
```

workflow default() {
  run check_toolchain()
}
EOF

JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" \
  jaiph run "${TEST_DIR}/docker_toolchain.jh" >/dev/null

e2e::expect_run_file "docker_toolchain.jh" "000002-script__check_toolchain.out" "toolchain ok"
