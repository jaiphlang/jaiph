#!/usr/bin/env bash
#
# security — shell injection through the `jaiph serve` param path (finding H-1)
# ============================================================================
# Black-box coverage that a caller-controlled workflow parameter cannot inject
# a shell command when it lands in a `shell` fallthrough body. `jaiph serve`
# binds request arguments positionally (`spec.params.map((p) => args[p] ?? "")`
# in src/cli/commands/serve.ts), so a POST body `{"name": "$(id)"}` is exactly
# the `args[p]` path the finding calls out. The runtime shell-quotes every
# interpolated value before it reaches `sh -c`, so the substitution must NOT
# execute.
#
# Observed side effects (real content equality is not feasible for the run JSON
# — volatile run_dir/timestamps — so we assert the meaningful signals):
#   - a `$(id)` param is echoed into an artifact literally, never evaluated
#     (the downloaded artifact must not contain `uid=`).
#   - a `$(touch <marker>)` param does not create the marker file.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "shell_injection_serve"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

if ! command -v python3 >/dev/null 2>&1; then
  e2e::fail "python3 required for JSON response validation"
fi
if ! command -v curl >/dev/null 2>&1; then
  e2e::fail "curl required for HTTP e2e"
fi

# `greet_shell` interpolates the caller's `name` into a `shell` fallthrough body
# (the `echo …` line is not a keyword, so it compiles to a shell exec) and
# redirects it into the run's artifacts dir so we can download the result.
e2e::file "tools.jh" <<'EOF'
# Echoes the greeting into an artifact via a shell line.
workflow greet_shell(name) {
  echo "Hello ${name}" > "$JAIPH_ARTIFACTS_DIR/greeting.txt"
}
EOF

e2e::section "jaiph serve param does not inject shell commands into a shell body"

serve_err="${TEST_DIR}/serve_stderr.txt"
: >"${serve_err}"

# Host-mode legs export JAIPH_UNSAFE=true; server modes refuse an inherited
# unsafe env without an explicit flag (finding M-1), so forward --unsafe as the
# consent. Docker legs leave JAIPH_UNSAFE unset → no flag → sandboxed default.
# No JAIPH_SERVE_TOKEN/OIDC here, so --allow-anonymous is required to bind even
# loopback with no auth (finding M-2).
jaiph serve --port 0 --allow-anonymous ${JAIPH_UNSAFE:+--unsafe} "${TEST_DIR}/tools.jh" >/dev/null 2>"${serve_err}" &
E2E_SERVER_PID="$!"

port=""
for _ in $(seq 1 50); do
  port="$(sed -nE 's#.*listening on http://[^:]+:([0-9]+).*#\1#p' "${serve_err}" | head -1)"
  if [[ -n "${port}" ]]; then
    break
  fi
  sleep 0.2
done
if [[ -z "${port}" ]]; then
  printf 'serve stderr:\n%s\n' "$(cat "${serve_err}")" >&2
  e2e::fail "jaiph serve did not print a listen URL"
fi
base="http://127.0.0.1:${port}"

# --- $(id) command substitution is not evaluated ---
run_json="$(curl -s -X POST "${base}/v1/workflows/greet_shell/runs?wait=true" \
  -H 'content-type: application/json' -d '{"name":"$(id)"}')"
run_id="$(printf '%s' "${run_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')"
run_status="$(printf '%s' "${run_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
e2e::assert_equals "${run_status}" "succeeded" "greet_shell run completes"

art_file="${TEST_DIR}/downloaded_greeting.txt"
curl -s "${base}/v1/runs/${run_id}/artifacts/greeting.txt" -o "${art_file}"
# Full-content equality: the $(id) text survives literally (shell-quoted), so
# the byte content is fixed. If the substitution had run, this would contain the
# host's `uid=…` and the equality would fail.
e2e::assert_equals "$(cat "${art_file}")" 'Hello $\(id\)' \
  "\$(id) is echoed literally into the artifact, never evaluated"

# --- $(touch marker) does not create a file ---
marker="${TEST_DIR}/pwned.txt"
rm -f "${marker}"
curl -s -X POST "${base}/v1/workflows/greet_shell/runs?wait=true" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"\$(touch ${marker})\"}" >/dev/null
if [[ -f "${marker}" ]]; then
  e2e::fail "shell injection: \$(touch) executed — marker file was created"
fi
e2e::pass "\$(touch <marker>) param created no file (no command execution)"
