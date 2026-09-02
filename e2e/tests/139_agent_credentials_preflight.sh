#!/usr/bin/env bash
#
# Host-side credential pre-flight: claude is silent when credentials are
# missing (stored CLI login is the host path); cursor warns and proceeds;
# codex hard-fails with E_AGENT_CREDENTIALS (no login fallback).
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "agent_credentials_preflight"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. claude + no creds → silent, proceed ─────────────────────────────────

e2e::section "claude without credentials is silent and proceeds"

e2e::file "claude_host.jh" <<'EOF'
config {
  agent.backend = "claude"
  agent.model = "sonnet-test"
}

export def main() {
  log "should not run"
}
EOF

err_file="$(mktemp)"
stdout_file="$(mktemp)"
exit_code=0
env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
  jaiph run "${TEST_DIR}/claude_host.jh" >"${stdout_file}" 2>"${err_file}" \
  || exit_code=$?
err_msg="$(cat "${err_file}")"
out_msg="$(cat "${stdout_file}")"
rm -f "${err_file}" "${stdout_file}"

if [[ "${exit_code}" != "0" ]]; then
  printf "stdout was:\n%s\nstderr was:\n%s\n" "${out_msg}" "${err_msg}" >&2
  e2e::fail "host run with missing claude creds should not hard-fail"
fi
e2e::pass "zero exit on host run with missing claude credentials"

if [[ "${err_msg}" == *"ANTHROPIC_API_KEY"* ]] || [[ "${err_msg}" == *"CLAUDE_CODE_OAUTH_TOKEN"* ]]; then
  printf "%s\n" "${err_msg}" >&2
  e2e::fail "claude host run must not warn about missing env credentials"
fi
e2e::pass "no claude credential warning"

if [[ "${err_msg}" == *"E_AGENT_CREDENTIALS"* ]]; then
  printf "%s\n" "${err_msg}" >&2
  e2e::fail "claude host run must not emit E_AGENT_CREDENTIALS"
fi
e2e::pass "no E_AGENT_CREDENTIALS on claude silent path"

# ── 2. codex + no OPENAI_API_KEY → hard fail (no login path) ────────────────

e2e::section "codex without OPENAI_API_KEY fails fast"

e2e::file "codex_host.jh" <<'EOF'
config {
  agent.backend = "codex"
}

export def main() {
  log "should not run"
}
EOF

err_file="$(mktemp)"
exit_code=0
env -u OPENAI_API_KEY \
  jaiph run "${TEST_DIR}/codex_host.jh" 2>"${err_file}" >/dev/null \
  || exit_code=$?
err_msg="$(cat "${err_file}")"
rm -f "${err_file}"

if [[ "${exit_code}" == "0" ]]; then
  printf "stderr was:\n%s\n" "${err_msg}" >&2
  e2e::fail "expected non-zero exit when OPENAI_API_KEY missing for codex (host)"
fi
e2e::assert_contains "${err_msg}" "E_AGENT_CREDENTIALS" "codex host: stderr names error code"
e2e::assert_contains "${err_msg}" "OPENAI_API_KEY" "codex host: stderr names the env var"
e2e::pass "codex hard-fails when OPENAI_API_KEY is missing"
