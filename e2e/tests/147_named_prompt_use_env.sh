#!/usr/bin/env bash

# Contract: named prompts (prompt name(params) [use KEY] = body).
#  - `prompt name(args)` invokes the named prompt; `${param}` interpolates in
#    the body (observed via a custom agent that echoes its stdin);
#  - `use KEY` + `--env KEY` injects the granted host key into that
#    invocation's agent subprocess, while an anonymous prompt stays sterile;
#  - `jaiph run` pre-flights the named-prompt `use` key (E_ENV_MISSING when
#    ungranted);
#  - `run name()` on a named prompt is E_VALIDATE.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "named_prompt_use_env"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

# Never inherit a real GH_TOKEN from the invoking shell.
unset GH_TOKEN || true

# Custom agent (cursor backend, agent.command path): echoes the prompt it
# received on stdin plus whatever GH_TOKEN it can see in its env.
AGENT="${TEST_DIR}/echo-agent.sh"
cat > "${AGENT}" <<'AGENT_EOF'
#!/usr/bin/env bash
body="$(cat)"
printf '%s\n' "PROMPT=[${body}] GH=[${GH_TOKEN:-<unset>}]"
AGENT_EOF
chmod 755 "${AGENT}"

e2e::file "named.jh" <<'EOF'
prompt privileged(x) use GH_TOKEN = "priv ${x}"

export def main() {
  const x = "arg-value"
  const named = prompt privileged(x)
  const anon = prompt "plain anonymous"
  return "named={${named}} anon={${anon}}"
}
EOF

e2e::section "named prompt: interpolation + use GH_TOKEN reaches the agent; anonymous stays sterile"

named_out="$(GH_TOKEN=e2e-gh-secret JAIPH_AGENT_BACKEND=cursor JAIPH_AGENT_COMMAND="${AGENT}" \
  e2e::run "named.jh" --env GH_TOKEN)"
# assert_contains: the agent-command tree line is path-normalized, the prompt
# stream lines vary, and the transported body carries its source quotes (shared
# with anonymous prompts), so full-tree equality is not feasible here.
e2e::assert_contains "${named_out}" "priv arg-value" \
  "named prompt interpolates \${x} in the body"
# The secret value appears only where GH_TOKEN crossed — i.e. the named prompt.
e2e::assert_contains "${named_out}" "GH=[e2e-gh-secret]" \
  "named prompt use GH_TOKEN + --env reaches the agent child env"
# The anonymous prompt in the same def sees GH_TOKEN unset (named got the secret).
e2e::assert_contains "${named_out}" "GH=[<unset>]" \
  "anonymous prompt in the same def does not receive GH_TOKEN"

e2e::section "named prompt use without --env fails pre-flight"

missing_out=""
if missing_out="$(GH_TOKEN=e2e-gh-secret JAIPH_AGENT_BACKEND=cursor JAIPH_AGENT_COMMAND="${AGENT}" \
  e2e::run "named.jh" 2>&1)"; then
  e2e::fail "named prompt: run should abort when a use key was not granted with --env"
fi
e2e::assert_contains "${missing_out}" "E_ENV_MISSING" "named prompt: ungranted use key aborts with E_ENV_MISSING"
e2e::assert_contains "${missing_out}" "prompt privileged" "named prompt: E_ENV_MISSING names the prompt"
e2e::assert_contains "${missing_out}" "uses GH_TOKEN" "named prompt: E_ENV_MISSING names the requested key"

e2e::section "run name() on a named prompt is E_VALIDATE"

e2e::file "run_prompt.jh" <<'EOF'
prompt classify(x) = "Classify ${x}"

export def main() {
  const c = "hi"
  run classify(c)
}
EOF

run_prompt_out=""
if run_prompt_out="$(e2e::run "run_prompt.jh" 2>&1)"; then
  e2e::fail "run on a named prompt should be rejected"
fi
e2e::assert_contains "${run_prompt_out}" "E_VALIDATE" "run-on-prompt: rejected with E_VALIDATE"
e2e::assert_contains "${run_prompt_out}" 'prompt "classify" cannot be called with run' \
  "run-on-prompt: message steers to prompt classify(...)"

e2e::pass "named prompt use/env, interpolation, preflight, and run-rejection contracts hold"
