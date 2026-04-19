#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "isolated_composition"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
# nested-isolated-direct-is-compile-error
# ---------------------------------------------------------------------------

e2e::section "nested-isolated-direct-is-compile-error"

e2e::file "nested_direct.jh" <<'EOF'
workflow inner() {
  run isolated other()
}

workflow other() {
  log "hello"
}

workflow default() {
  run isolated inner()
}
EOF

set +e
out_direct="$(e2e::run "nested_direct.jh" 2>&1)"
exit_direct=$?
set -e

e2e::assert_equals "${exit_direct}" "1" "compile exits 1 for nested isolated (direct)"
# nondeterministic error formatting — check key phrase
e2e::assert_contains "${out_direct}" "nested isolation is not allowed" "error mentions nested isolation"
e2e::pass "nested-isolated-direct-is-compile-error"

# ---------------------------------------------------------------------------
# nested-isolated-transitive-is-compile-error
# ---------------------------------------------------------------------------

e2e::section "nested-isolated-transitive-is-compile-error"

e2e::file "nested_transitive.jh" <<'EOF'
workflow deep() {
  run isolated leaf()
}

workflow leaf() {
  log "leaf"
}

workflow middle() {
  run deep()
}

workflow outer() {
  run middle()
}

workflow default() {
  run isolated outer()
}
EOF

set +e
out_trans="$(e2e::run "nested_transitive.jh" 2>&1)"
exit_trans=$?
set -e

e2e::assert_equals "${exit_trans}" "1" "compile exits 1 for nested isolated (transitive)"
# nondeterministic error formatting — check key phrase
e2e::assert_contains "${out_trans}" "nested isolation is not allowed" "error mentions nested isolation (transitive)"
e2e::pass "nested-isolated-transitive-is-compile-error"

# ---------------------------------------------------------------------------
# nested-isolated-runtime-guard
# ---------------------------------------------------------------------------

e2e::section "nested-isolated-runtime-guard"

# This test verifies the runtime defense-in-depth guard. We simulate being
# inside an isolated context by setting JAIPH_ISOLATED=1 in the environment.
# The runtime should refuse to run a nested `run isolated` even if the
# static check was bypassed.

e2e::file "runtime_guard.jh" <<'EOF'
workflow target() {
  log "should not run"
}

workflow default() {
  run isolated target()
}
EOF

set +e
# nondeterministic stderr — check key phrase
out_guard="$(JAIPH_ISOLATED=1 JAIPH_UNSAFE=true e2e::run "runtime_guard.jh" 2>&1)"
exit_guard=$?
set -e

e2e::assert_equals "${exit_guard}" "1" "runtime guard exits 1 inside isolated context"
# nondeterministic error — check key phrase
e2e::assert_contains "${out_guard}" "nested isolation is not allowed" "runtime guard error mentions nested isolation"
e2e::pass "nested-isolated-runtime-guard"

# ---------------------------------------------------------------------------
# isolated-fails-without-backend
# ---------------------------------------------------------------------------

e2e::section "isolated-fails-without-backend"

e2e::file "isolated_no_docker.jh" <<'EOF'
workflow target() {
  log "should not run"
}

workflow default() {
  run isolated target()
}
EOF

# Create a fake docker that always fails, prepend it to PATH
fake_docker_dir="$(mktemp -d)"
cat > "${fake_docker_dir}/docker" << 'FAKE'
#!/bin/sh
echo "docker: command not found" >&2
exit 127
FAKE
chmod +x "${fake_docker_dir}/docker"

set +e
# nondeterministic error — check key phrase
out_nobackend="$(PATH="${fake_docker_dir}:${PATH}" JAIPH_UNSAFE=true e2e::run "isolated_no_docker.jh" 2>&1)"
exit_nobackend=$?
set -e
rm -rf "${fake_docker_dir}"

e2e::assert_equals "${exit_nobackend}" "1" "run isolated exits 1 without backend"
# nondeterministic error — check key phrase
e2e::assert_contains "${out_nobackend}" "isolated execution requires" "error mentions isolated execution requires"
e2e::pass "isolated-fails-without-backend"
