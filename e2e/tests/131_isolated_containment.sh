#!/usr/bin/env bash
#
# Containment tests for `run isolated`. Require a real Docker backend with
# fuse-overlayfs. Skip with explicit error when backend is unavailable.
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "isolated_containment"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Guard: skip all containment tests if Docker is not available
if ! docker info >/dev/null 2>&1; then
  e2e::section "isolated containment (Docker required)"
  e2e::skip "Docker is not available — skipping containment tests"
  exit 0
fi

# Build a local e2e image so we don't need GHCR auth
if ! e2e::ensure_docker_test_image; then
  e2e::section "isolated containment (Docker image build)"
  e2e::skip "Could not build local Docker test image — skipping containment tests"
  exit 0
fi
export JAIPH_ISOLATED_IMAGE="${E2E_DOCKER_TEST_IMAGE}"

# ---------------------------------------------------------------------------
# isolated-cannot-write-host-workspace
# ---------------------------------------------------------------------------

e2e::section "isolated-cannot-write-host-workspace"

e2e::file "host_write.jh" <<'EOF'
script write_file = `echo "written-by-branch" > host_canary.txt`

workflow writer() {
  run write_file()
}

workflow default() {
  run isolated writer()
}
EOF

# Place a canary file in the workspace
echo "original" > "${TEST_DIR}/host_canary.txt"

set +e
out_hw="$(e2e::run "host_write.jh" 2>&1)"
exit_hw=$?
set -e

# Host file should be unchanged — branch writes go to overlay
host_content="$(cat "${TEST_DIR}/host_canary.txt")"
e2e::assert_equals "${host_content}" "original" "host workspace file unchanged after isolated run"
e2e::pass "isolated-cannot-write-host-workspace"

# ---------------------------------------------------------------------------
# isolated-cannot-read-host-secret
# ---------------------------------------------------------------------------

e2e::section "isolated-cannot-read-host-secret"

CANARY_PATH="$HOME/.jaiph-isolation-canary"
CANARY_VALUE="secret-canary-$(date +%s)"
echo "${CANARY_VALUE}" > "${CANARY_PATH}"

e2e::file "read_secret.jh" <<'EOF'
script try_read = ```
if [ -f "$HOME/.jaiph-isolation-canary" ]; then
  cat "$HOME/.jaiph-isolation-canary"
else
  echo "NOT_FOUND"
fi
```

workflow reader() {
  const result = run try_read()
  log "${result}"
}

workflow default() {
  run isolated reader()
}
EOF

set +e
out_rs="$(e2e::run "read_secret.jh" 2>&1)"
exit_rs=$?
set -e

rm -f "${CANARY_PATH}"

# The branch should NOT be able to read the host secret
if [[ "${out_rs}" == *"${CANARY_VALUE}"* ]]; then
  e2e::fail "isolated branch could read host secret"
fi
e2e::pass "isolated-cannot-read-host-secret"

# ---------------------------------------------------------------------------
# isolated-cannot-kill-coordinator
# ---------------------------------------------------------------------------

e2e::section "isolated-cannot-kill-coordinator"

e2e::file "kill_parent.jh" <<'EOF'
script try_kill = ```
# Try to kill the parent process (coordinator)
kill -9 $PPID 2>/dev/null || true
echo "kill-attempted"
```

workflow killer() {
  run try_kill()
}

workflow default() {
  run isolated killer()
}
EOF

set +e
out_kp="$(e2e::run "kill_parent.jh" 2>&1)"
exit_kp=$?
set -e

# The coordinator must survive — it should still report a result
# nondeterministic: isolated might fail or succeed, but coordinator is alive
e2e::assert_contains "${out_kp}" "Jaiph:" "coordinator survived kill attempt"
e2e::pass "isolated-cannot-kill-coordinator"

# ---------------------------------------------------------------------------
# isolated-env-denylist
# ---------------------------------------------------------------------------

e2e::section "isolated-env-denylist"

e2e::file "env_denylist.jh" <<'EOF'
script check_env = ```
if [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  echo "LEAKED:${AWS_SECRET_ACCESS_KEY}"
else
  echo "CLEAN"
fi
```

workflow checker() {
  const result = run check_env()
  log "${result}"
}

workflow default() {
  run isolated checker()
}
EOF

set +e
out_ed="$(AWS_SECRET_ACCESS_KEY=canary-value e2e::run "env_denylist.jh" 2>&1)"
exit_ed=$?
set -e

if [[ "${out_ed}" == *"canary-value"* ]]; then
  e2e::fail "AWS_SECRET_ACCESS_KEY leaked into isolated container"
fi
e2e::pass "isolated-env-denylist"

# ---------------------------------------------------------------------------
# isolated-writable-workspace
# ---------------------------------------------------------------------------

e2e::section "isolated-writable-workspace"

e2e::file "writable_ws.jh" <<'EOF'
script write_and_read = ```
echo "branch-content" > branch_file.txt
cat branch_file.txt
```

workflow writer() {
  const result = run write_and_read()
  log "${result}"
}

workflow default() {
  run isolated writer()
}
EOF

set +e
out_ww="$(e2e::run "writable_ws.jh" 2>&1)"
exit_ww=$?
set -e

# Branch can write to its overlay workspace
# nondeterministic output — check key content
e2e::assert_contains "${out_ww}" "branch-content" "branch wrote to overlay workspace"

# But host doesn't have the file
if [ -f "${TEST_DIR}/branch_file.txt" ]; then
  e2e::fail "branch file leaked to host workspace"
fi
e2e::pass "isolated-writable-workspace"

# ---------------------------------------------------------------------------
# isolated-export-survives-teardown
# ---------------------------------------------------------------------------

e2e::section "isolated-export-survives-teardown"

e2e::file "export_survives.jh" <<'EOF'
script create_artifact = ```
# Write to the run artifacts directory (mounted :rw)
echo "artifact-data" > "$JAIPH_RUNS_DIR/test-artifact.txt"
```

workflow exporter() {
  run create_artifact()
}

workflow default() {
  run isolated exporter()
}
EOF

set +e
out_es="$(e2e::run "export_survives.jh" 2>&1)"
exit_es=$?
set -e

# Check that the artifact was written to a branch run directory
found_artifact=0
for f in "${TEST_DIR}/.jaiph/runs/"*/*/branches/*/test-artifact.txt; do
  if [ -f "$f" ]; then
    content="$(cat "$f")"
    if [ "${content}" = "artifact-data" ]; then
      found_artifact=1
    fi
  fi
done

if [ "${found_artifact}" -eq 0 ]; then
  # Also check directly in runs dir in case branch structure differs
  for f in "${TEST_DIR}/.jaiph/runs/"*/*/test-artifact.txt; do
    if [ -f "$f" ]; then
      content="$(cat "$f")"
      if [ "${content}" = "artifact-data" ]; then
        found_artifact=1
      fi
    fi
  done
fi

e2e::assert_equals "${found_artifact}" "1" "exported artifact survives container teardown"
e2e::pass "isolated-export-survives-teardown"

# ---------------------------------------------------------------------------
# isolated-non-isolated-inner-call-shares-context
# ---------------------------------------------------------------------------

e2e::section "isolated-non-isolated-inner-call-shares-context"

e2e::file "shared_context.jh" <<'EOF'
script check_isolated = ```
if [ "${JAIPH_ISOLATED:-}" = "1" ]; then
  echo "INSIDE_ISOLATED"
else
  echo "NOT_ISOLATED"
fi
```

workflow inner() {
  const result = run check_isolated()
  log "${result}"
}

workflow outer() {
  # Non-isolated run inside an isolated body shares the same container
  run inner()
}

workflow default() {
  run isolated outer()
}
EOF

set +e
out_sc="$(e2e::run "shared_context.jh" 2>&1)"
exit_sc=$?
set -e

# A non-isolated `run` inside an isolated body should still be in the sandbox
# nondeterministic output — check key content
e2e::assert_contains "${out_sc}" "INSIDE_ISOLATED" "inner non-isolated run shares isolated context"
e2e::pass "isolated-non-isolated-inner-call-shares-context"
