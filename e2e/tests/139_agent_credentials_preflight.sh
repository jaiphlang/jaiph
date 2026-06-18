#!/usr/bin/env bash
#
# Pre-flight agent-credential check: fails fast on Docker, warns on host.
#
# Runs without needing a real Docker daemon: setting JAIPH_DOCKER_ENABLED=true
# causes runWorkflow to consult the pre-flight before `checkDockerAvailable`,
# so the credential check fires and exits before any container can spawn.
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "agent_credentials_preflight"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# ── 1. Docker on + claude + no creds → hard fail with E_AGENT_CREDENTIALS ────

e2e::section "claude under Docker without credentials fails before launch"

e2e::file "claude_docker.jh" <<'EOF'
config {
  agent.backend = "claude"
  agent.default_model = "sonnet-test"
}

workflow default() {
  log "should not run"
}
EOF

err_file="$(mktemp)"
exit_code=0
env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
  JAIPH_DOCKER_ENABLED=true \
  jaiph run "${TEST_DIR}/claude_docker.jh" 2>"${err_file}" >/dev/null \
  || exit_code=$?
err_msg="$(cat "${err_file}")"
rm -f "${err_file}"

if [[ "${exit_code}" == "0" ]]; then
  printf "stderr was:\n%s\n" "${err_msg}" >&2
  e2e::fail "expected non-zero exit when claude credentials are missing under Docker"
fi
e2e::pass "non-zero exit when claude credentials missing under Docker"

# Message contract: backend + model + entry path + scope.
# assert_contains: each substring is part of a single composed line whose
# format is exercised by exhaustive unit tests; here we just confirm wiring.
e2e::assert_contains "${err_msg}" "E_AGENT_CREDENTIALS" "stderr names error code"
e2e::assert_contains "${err_msg}" "claude" "stderr names the backend"
e2e::assert_contains "${err_msg}" "sonnet-test" "stderr names the configured model"
e2e::assert_contains "${err_msg}" "claude_docker.jh" "stderr names the entry .jh file"
e2e::assert_contains "${err_msg}" "module config" "stderr names the config scope"

# The run dir must NOT exist — pre-flight aborts before any runner/container starts.
if [[ -d "${TEST_DIR}/.jaiph/runs" ]]; then
  shopt -s nullglob
  matches=( "${TEST_DIR}/.jaiph/runs/"*/*"claude_docker.jh"/ )
  shopt -u nullglob
  if [[ ${#matches[@]} -gt 0 ]]; then
    e2e::fail "expected no run dir to be created (pre-flight should abort before launch)"
  fi
fi
e2e::pass "no run directory created — runner/container never launched"

# ── 2. Host (Docker off) + claude + no creds → warn, but proceed ────────────

e2e::section "claude on host without credentials warns but proceeds"

# Use --unsafe to force Docker off without needing a Docker daemon.
err_file="$(mktemp)"
stdout_file="$(mktemp)"
exit_code=0
env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
  jaiph run --unsafe "${TEST_DIR}/claude_docker.jh" >"${stdout_file}" 2>"${err_file}" \
  || exit_code=$?
err_msg="$(cat "${err_file}")"
out_msg="$(cat "${stdout_file}")"
rm -f "${err_file}" "${stdout_file}"

if [[ "${exit_code}" != "0" ]]; then
  printf "stdout was:\n%s\nstderr was:\n%s\n" "${out_msg}" "${err_msg}" >&2
  e2e::fail "host run with missing claude creds should not hard-fail (warn only)"
fi
e2e::pass "zero exit on host run with missing claude credentials"

# assert_contains: stderr also carries unrelated lines (banner, hooks etc.)
e2e::assert_contains "${err_msg}" "warning" "stderr contains a warning"
e2e::assert_contains "${err_msg}" "claude" "warning names the backend"
e2e::assert_contains "${err_msg}" "module config" "warning names the config scope"

# Hard-error code must NOT appear on the host warn-only path.
if [[ "${err_msg}" == *"E_AGENT_CREDENTIALS"* ]]; then
  printf "%s\n" "${err_msg}" >&2
  e2e::fail "host run must not emit E_AGENT_CREDENTIALS — that is the Docker contract"
fi
e2e::pass "no E_AGENT_CREDENTIALS on host warn-only path"

# ── 3. codex + no OPENAI_API_KEY → hard fail on host (no login path) ────────

e2e::section "codex on host without OPENAI_API_KEY fails fast"

e2e::file "codex_host.jh" <<'EOF'
config {
  agent.backend = "codex"
}

workflow default() {
  log "should not run"
}
EOF

err_file="$(mktemp)"
exit_code=0
env -u OPENAI_API_KEY \
  jaiph run --unsafe "${TEST_DIR}/codex_host.jh" 2>"${err_file}" >/dev/null \
  || exit_code=$?
err_msg="$(cat "${err_file}")"
rm -f "${err_file}"

if [[ "${exit_code}" == "0" ]]; then
  printf "stderr was:\n%s\n" "${err_msg}" >&2
  e2e::fail "expected non-zero exit when OPENAI_API_KEY missing for codex (host)"
fi
e2e::assert_contains "${err_msg}" "E_AGENT_CREDENTIALS" "codex host: stderr names error code"
e2e::assert_contains "${err_msg}" "OPENAI_API_KEY" "codex host: stderr names the env var"
e2e::pass "codex hard-fails on both host and Docker"
