#!/usr/bin/env bash

# ---------------------------------------------------------------------------
# Snapshot-sandbox isolation contract (the spec for the default Docker mode).
#
# In the default (snapshot) mode the container receives a WRITABLE POINT-IN-TIME
# SNAPSHOT of the workspace taken at run start. This test drives a real
# Docker-backed `jaiph run` and asserts the three halves of that contract:
#
#   1. Host edits DURING the run are invisible to the container. The workflow
#      sleeps, then reads a workspace file that the host mutates mid-run; the
#      container must still see the snapshot-time content.
#   2. Container workspace WRITES are discarded — a file the container writes to
#      /jaiph/workspace never appears on the host workspace.
#   3. The LIVE host workspace is never mounted: /jaiph/workspace inside the
#      container is backed by the snapshot dir (…/sandbox), not the checkout.
#
# The workflow copies its observations into JAIPH_ARTIFACTS_DIR (persisted on
# the host run mount) so the host side can assert on them after the run.
#
# The whole test is gated on Docker being available; it skips cleanly otherwise.
# ---------------------------------------------------------------------------

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_snapshot_isolation"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker snapshot isolation (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping snapshot isolation tests"
  exit 0
fi

if ! e2e::ensure_docker_test_image; then
  e2e::section "docker snapshot isolation (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

e2e::section "docker snapshot isolation — writable point-in-time snapshot contract"

# Workspace file the container will read AFTER the host mutates it mid-run.
e2e::file "marker.txt" <<'EOF'
snapshot-time
EOF

# The workflow: sleep long enough for the host to mutate marker.txt after the
# snapshot was taken, then record what the container actually sees.
e2e::file "snap.jh" <<'EOF'
script observe_impl = ```
set -eu
# The host mutates marker.txt after the container starts; wait past that.
sleep 6
cat "${JAIPH_WORKSPACE}/marker.txt" > "${JAIPH_ARTIFACTS_DIR}/seen_marker.txt"
# A container-side workspace write — must be discarded (snapshot is disposable).
echo "written-by-container" > "${JAIPH_WORKSPACE}/container_wrote.txt"
# Prove /jaiph/workspace is backed by the snapshot dir, not the live checkout.
grep ' /jaiph/workspace ' /proc/self/mountinfo > "${JAIPH_ARTIFACTS_DIR}/ws_mount.txt" || true
```

workflow default() {
  run observe_impl()
}
EOF

# Start the Docker-backed run in the background (default = snapshot mode).
JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" \
  jaiph run "${TEST_DIR}/snap.jh" >/dev/null 2>&1 &
bg_pid=$!

# Wait (up to ~15s) for the WORKFLOW container to come up. Match on the
# deterministic run-container name (`jaiph-run-<hex>`, set by spawnDockerProcess)
# rather than the image ancestor: image preparation runs a short-lived
# `verifyImageHasJaiph` probe container from the same image *before* the snapshot
# is taken, and an ancestor filter would latch onto that probe — editing the host
# file pre-snapshot and defeating the test. The snapshot clone completes
# synchronously right before the named container launches, so any host edit after
# this point is strictly post-snapshot.
started=""
for ((i = 0; i < 30; i++)); do
  if [[ -n "$(docker ps -q --filter "name=jaiph-run" 2>/dev/null)" ]]; then
    started="yes"
    break
  fi
  sleep 0.5
done
if [[ -z "${started}" ]]; then
  kill "${bg_pid}" 2>/dev/null || true
  wait "${bg_pid}" 2>/dev/null || true
  e2e::fail "docker snapshot isolation: container never started"
fi

# Mutate the host workspace file mid-run. The container's script is still
# sleeping; when it wakes it must see the snapshot-time content, not this.
printf 'mutated-mid-run\n' > "${TEST_DIR}/marker.txt"

# Wait for the run to finish.
wait "${bg_pid}" || true

run_dir="$(e2e::run_dir "snap.jh")"
artifacts="${run_dir}artifacts"

# (1) The container saw the snapshot-time content, not the mid-run mutation.
seen="$(cat "${artifacts}/seen_marker.txt" 2>/dev/null || echo "<missing>")"
e2e::assert_equals "${seen}" "snapshot-time" \
  "snapshot isolation: container read snapshot-time content despite mid-run host edit"

# (2) The container's workspace write did not leak onto the host workspace.
if [[ -e "${TEST_DIR}/container_wrote.txt" ]]; then
  e2e::fail "snapshot isolation: container workspace write leaked onto the host"
fi
e2e::pass "snapshot isolation: container workspace write is discarded (absent on host)"

# (3) /jaiph/workspace is backed by the snapshot dir, not the live checkout.
ws_mount="$(cat "${artifacts}/ws_mount.txt" 2>/dev/null || echo "")"
e2e::assert_contains "${ws_mount}" "sandbox" \
  "snapshot isolation: /jaiph/workspace mount source is the snapshot dir (…/sandbox)"

# The host marker still holds the mid-run mutation (sanity: we really did edit it).
host_marker="$(cat "${TEST_DIR}/marker.txt")"
e2e::assert_equals "${host_marker}" "mutated-mid-run" \
  "snapshot isolation: host workspace file reflects the mid-run edit (control)"
