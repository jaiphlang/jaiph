#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "chain_key_off_leader_env"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ---------------------------------------------------------------------------
e2e::section "audit-chain key is never on the workflow leader's environment"
# ---------------------------------------------------------------------------
# Regression for the "keep the audit-chain key out of the leader's environment"
# finding: a script child of the same OS user can read its parent's exec-time
# environment (`ps eww -p $PPID`, or /proc/$PPID/environ on Linux). The per-run
# chain key must NOT be there — otherwise an audited program reads it and forges
# a journal that verifies. The key is handed to the leader out of band (a private
# tmpdir file that the leader reads and removes at startup); only the file path
# rides on the leader env, and it points at an already-deleted file by the time
# any step runs.

# Isolate the operator-side key store to this workspace so the test never touches
# the real home store, and so it can read back the persisted key for the
# value-leak check.
export JAIPH_AUDIT_KEY_DIR="${TEST_DIR}/audit-keys"
rm -rf "${JAIPH_AUDIT_KEY_DIR}"

e2e::file "leader_env.jh" <<'EOF'
script probe_parent_env = '''
set -eu
out="$JAIPH_WORKSPACE/parent_env.txt"
if [ -r "/proc/$PPID/environ" ]; then
  tr '\0' '\n' < "/proc/$PPID/environ" > "$out"
else
  ps eww -p "$PPID" > "$out"
fi
echo "probe-ok"
'''

export def main() {
  probe_parent_env()
}
EOF

rm -rf "${TEST_DIR}/runs_leader"
JAIPH_RUNS_DIR="runs_leader" e2e::run "leader_env.jh" >/dev/null

run_dir="$(e2e::run_dir_at "${TEST_DIR}/runs_leader" "leader_env.jh")"

# The script actually ran.
shopt -s nullglob
probe_files=( "${run_dir}"*probe_parent_env.out )
shopt -u nullglob
[[ ${#probe_files[@]} -ge 1 ]] || e2e::fail "expected probe_parent_env .out artifact"
e2e::assert_equals "$(<"${probe_files[0]}")" "probe-ok" "probe step ran"

env_dump="$(<"${TEST_DIR}/parent_env.txt")"

# Sanity: the dump captured the real leader exec-time env (JAIPH_WORKSPACE rides
# on the spawn env, so it must be present). JAIPH_RUN_DIR is deliberately NOT
# checked here — the runtime sets it after exec, so it is absent from the
# exec-time environ snapshot a child can read.
e2e::assert_contains "${env_dump}" "JAIPH_WORKSPACE=" \
  "leader env dump captured the real environment"  # full env is unbounded/host-dependent

# AC1: the chain key must not appear anywhere in the leader's environment.
if printf '%s' "${env_dump}" | grep -q "JAIPH_CHAIN_KEY"; then
  printf "leader env unexpectedly contained JAIPH_CHAIN_KEY:\n%s\n" "${env_dump}" >&2
  e2e::fail "chain key env var leaked onto the leader environment"
fi
e2e::pass "JAIPH_CHAIN_KEY is absent from the leader environment"

# AC3: only the off-process file pointer rides on the leader env, and it points at
# a file the leader already removed before the step ran.
key_file_path="$(printf '%s\n' "${env_dump}" | grep -o 'JAIPH_AUDIT_KEY_FILE=[^ ]*' | head -1 | cut -d= -f2-)"
[[ -n "${key_file_path}" ]] || e2e::fail "expected JAIPH_AUDIT_KEY_FILE pointer on the leader env"
[[ ! -e "${key_file_path}" ]] || e2e::fail "chain key file still exists during a step: ${key_file_path}"
e2e::pass "chain key file was removed before the step ran"

# The persisted key (operator-side store, written only after the run is terminal)
# must never appear in the mid-run leader env dump either.
shopt -s nullglob
key_files=( "${JAIPH_AUDIT_KEY_DIR}"/*/key )
shopt -u nullglob
[[ ${#key_files[@]} -eq 1 ]] || e2e::fail "expected exactly one persisted audit key, got ${#key_files[@]}"
persisted_key="$(<"${key_files[0]}")"
[[ -n "${persisted_key}" ]] || e2e::fail "persisted audit key is empty"
if printf '%s' "${env_dump}" | grep -qF "${persisted_key}"; then
  e2e::fail "chain key VALUE leaked into the leader environment"
fi
e2e::pass "chain key value is absent from the leader environment"

# AC2: the run's journal still verifies under the persisted key.
verify_out="$(JAIPH_AUDIT_KEY_DIR="${JAIPH_AUDIT_KEY_DIR}" node -e '
  const { verifyRunJournal } = require("'"${ROOT_DIR}"'/dist/src/runtime/index.js");
  const res = verifyRunJournal(process.argv[1]);
  process.stdout.write(JSON.stringify(res));
' "${run_dir%/}")"
e2e::assert_equals "${verify_out}" '{"verified":true,"ok":true}' "journal verifies under the persisted key"

e2e::pass "audit-chain key stays off the leader environment and the journal verifies"
