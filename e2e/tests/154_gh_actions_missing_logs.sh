#!/usr/bin/env bash

# Contract: check-ci must leave a nonempty failure report when GitHub has no
# job logs (`gh run view --log-failed` → `log not found: <job id>`). The
# recover path in gh_ci_passes.jh reads that file; an empty file used to abort
# before the agent ran.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "gh_actions_missing_logs"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

if ! command -v jq >/dev/null 2>&1; then
  e2e::skip "jq is required by gh_actions.sh"
  exit 0
fi

e2e::section "check-ci writes a fallback report when job logs are missing"

cat >"${JAIPH_E2E_BIN_DIR}/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "run" ] && [ "${2:-}" = "list" ]; then
  cat <<'JSON'
[{"databaseId":35718989895,"status":"completed","conclusion":"failure","url":"https://github.com/jaiphlang/jaiph/actions/runs/35718989895","headBranch":"nightly","headSha":"abc123def","createdAt":"2026-09-22T10:59:50Z"}]
JSON
  exit 0
fi
if [ "${1:-}" = "run" ] && [ "${2:-}" = "view" ]; then
  for arg in "$@"; do
    if [ "$arg" = "--log-failed" ] || [ "$arg" = "--log" ]; then
      echo "log not found: 106717181723" >&2
      exit 1
    fi
  done
  cat <<'VIEW'
X Native Windows smoke (windows-latest, no WSL)	failure
  Run native Windows smoke	in_progress
VIEW
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 2
EOF
chmod +x "${JAIPH_E2E_BIN_DIR}/gh"

LOG_FILE="${TEST_DIR}/ci-failure.log"
set +e
check_out="$(
  cd "${TEST_DIR}"
  GITHUB_TOKEN=e2e-dummy \
    bash "${ROOT_DIR}/.jaiph/libs/jaiphlang/gh_actions.sh" \
    check-ci nightly abc123def CI "${LOG_FILE}" 2>&1
)"
check_rc=$?
set -e

if [ "${check_rc}" -eq 0 ]; then
  printf '%s\n' "${check_out}" >&2
  e2e::fail "check-ci must exit 1 when the run conclusion is failure"
fi
e2e::pass "check-ci exits 1 for a failed run"

e2e::assert_file_exists "${LOG_FILE}" "fallback log file exists"
# Full-file compare is not used: the dest path is interpolated into the header.
# Why substring: the report is a composed header + gh stderr + metadata dump.
log_body="$(<"${LOG_FILE}")"
e2e::assert_contains "${log_body}" "CI failed (failure): https://github.com/jaiphlang/jaiph/actions/runs/35718989895 (run 35718989895)" "fallback names the failed run"
e2e::assert_contains "${log_body}" "log not found: 106717181723" "fallback keeps the gh log-not-found error"
e2e::assert_contains "${log_body}" "Native Windows smoke" "fallback includes gh run view metadata"

e2e::section "gh_ci_passes recover persists failure text when the log file is empty"

mkdir -p "${TEST_DIR}/.jaiph/libs/jaiphlang"
cp "${ROOT_DIR}/.jaiph/gh_ci_passes.jh" "${TEST_DIR}/.jaiph/gh_ci_passes.jh"
cp "${ROOT_DIR}/.jaiph/gh_ci_passes.test.jh" "${TEST_DIR}/.jaiph/gh_ci_passes.test.jh"
cp "${ROOT_DIR}/.jaiph/lib_common.jh" "${TEST_DIR}/.jaiph/lib_common.jh"
cp "${ROOT_DIR}/.jaiph/libs/jaiphlang/gh_actions.jh" "${TEST_DIR}/.jaiph/libs/jaiphlang/gh_actions.jh"
cp "${ROOT_DIR}/.jaiph/libs/jaiphlang/gh_actions.sh" "${TEST_DIR}/.jaiph/libs/jaiphlang/gh_actions.sh"
cp "${ROOT_DIR}/.jaiph/libs/jaiphlang/git.jh" "${TEST_DIR}/.jaiph/libs/jaiphlang/git.jh"

test_out="$(
  cd "${TEST_DIR}"
  jaiph test ".jaiph/gh_ci_passes.test.jh"
)"
e2e::expect_stdout "${test_out}" <<'EOF'
testing gh_ci_passes.test.jh
  ▸ recover continues when check-ci leaves an empty log
  ✓ <time>
✓ 1 test(s) passed
EOF
