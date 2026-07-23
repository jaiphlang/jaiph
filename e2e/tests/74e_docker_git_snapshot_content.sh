#!/usr/bin/env bash

# ---------------------------------------------------------------------------
# Git-defined snapshot content (the spec for what the container can see).
#
# In the default (snapshot) mode the container receives a git-defined view of
# the workspace: exactly the files git reports (tracked + untracked-but-not-
# ignored) plus `.git/` wholesale. Gitignored files and directories are ABSENT
# from the container — never copied, never scanned.
#
# This drives a real Docker-backed `jaiph run` in a git workspace containing:
#   - a tracked file,
#   - an untracked, non-ignored file,
#   - a gitignored `.env`-style file,
#   - a gitignored `node_modules/`-style directory,
# and asserts (from inside the container, via artifacts) that the first two are
# present and the ignored file AND directory are absent, and that `.git/` is
# present and functional (`git log -1` succeeds in-container).
#
# The whole test is gated on Docker being available; it skips cleanly otherwise.
# ---------------------------------------------------------------------------

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "docker_git_snapshot_content"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "docker git snapshot content (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping git snapshot content tests"
  exit 0
fi

if ! e2e::ensure_docker_test_image; then
  e2e::section "docker git snapshot content (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

e2e::section "docker git snapshot content — gitignored files never enter the sandbox"

# A git workspace: one tracked file, one untracked non-ignored file, a
# gitignored secret file, and a gitignored dependency directory.
e2e::file "tracked.txt"   <<<'tracked'
e2e::file ".gitignore"    <<'EOF'
.env
node_modules/
EOF
e2e::file ".env"                      <<<'SECRET=leak'
e2e::file "node_modules/pkg/index.js" <<<'ignored-dep'

git -C "${TEST_DIR}" init -q
git -C "${TEST_DIR}" config user.email "t@t.test"
git -C "${TEST_DIR}" config user.name "Test"
git -C "${TEST_DIR}" config commit.gpgsign false
git -C "${TEST_DIR}" add tracked.txt .gitignore
git -C "${TEST_DIR}" commit -qm init

# untracked.txt is created AFTER the commit — it is untracked but not ignored,
# so it must still appear in the snapshot.
e2e::file "untracked.txt" <<<'untracked'

# The workflow records, from inside the container, what the snapshot contains.
e2e::file "probe.jh" <<'EOF'
script probe_impl = ```
set -eu
out="${JAIPH_ARTIFACTS_DIR}/seen.txt"
{
  test -f "${JAIPH_WORKSPACE}/tracked.txt"        && echo "tracked=present"   || echo "tracked=absent"
  test -f "${JAIPH_WORKSPACE}/untracked.txt"      && echo "untracked=present" || echo "untracked=absent"
  test -e "${JAIPH_WORKSPACE}/.env"               && echo "env=present"       || echo "env=absent"
  test -e "${JAIPH_WORKSPACE}/node_modules"       && echo "node_modules=present" || echo "node_modules=absent"
} > "${out}"
# .git must be present AND functional inside the container. Bind-mount ownership
# can trip git's "dubious ownership" guard (container user vs mounted files) —
# an environment quirk, not a content one — so allow the workspace explicitly,
# exactly the remedy git prints. History must then be readable from `.git/`.
git config --global --add safe.directory "${JAIPH_WORKSPACE}" || true
if git -C "${JAIPH_WORKSPACE}" log -1 --format=%s > "${JAIPH_ARTIFACTS_DIR}/gitout.txt" 2> "${JAIPH_ARTIFACTS_DIR}/giterr.txt"; then
  echo "git_log=ok" >> "${out}"
else
  echo "git_log=fail" >> "${out}"
fi
```

workflow default() {
  run probe_impl()
}
EOF

JAIPH_DOCKER_ENABLED=true JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}" \
  jaiph run "${TEST_DIR}/probe.jh" >/dev/null 2>&1

run_dir="$(e2e::run_dir "probe.jh")"
seen="$(cat "${run_dir}artifacts/seen.txt" 2>/dev/null || echo "<missing>")"

# Full equality on the recorded observations — the exact content contract.
e2e::assert_equals "${seen}" "$(cat <<'EOF'
tracked=present
untracked=present
env=absent
node_modules=absent
git_log=ok
EOF
)" "git snapshot: tracked+untracked present, gitignored file AND dir absent, .git functional"
