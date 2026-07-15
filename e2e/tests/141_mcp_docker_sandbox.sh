#!/usr/bin/env bash
#
# MCP 7/8 — `jaiph mcp` Docker sandbox parity (inplace by default)
# ================================================================
# Black-box coverage through the real `jaiph` entrypoint (design:
# design/2026-07-14-mcp-server.md -> "Safety posture"). With Docker enabled,
# `jaiph mcp` tool calls honor the same env-driven sandbox as `jaiph run`, with
# two MCP-specific rules:
#
#   1. Inplace is the DEFAULT mode — a tool call runs in a container bound to the
#      real workspace, so effects land live and a non-`default` tool symbol
#      returns its value correctly (would fail if the inner run hardcoded
#      `default`). A failing tool call composes an `isError` result with a
#      host-side `run dir:` pointer discovered from the sandbox runs mount.
#   2. Explicit isolation (JAIPH_INPLACE=0) is honored — the same call runs, but
#      its workspace writes are discarded; the host workspace is untouched.
#
# Plus: `--env` pairs cross into the per-call container (a non-allowlisted key
# supplied via `--env` is readable inside the workflow).
#
# Each scenario drives its own short-lived `jaiph mcp` server with a single
# tool call — the realistic MCP pattern (an agent awaits each result). Two
# *concurrent* same-second runs share a run directory (a documented race — see
# docs/mcp.md), so we deliberately do not overlap calls here.
#
# The whole test is gated on Docker being available; it skips cleanly otherwise.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "mcp_docker_sandbox"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

if ! command -v python3 >/dev/null 2>&1; then
  e2e::fail "python3 required for JSON-RPC stdout parsing"
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "mcp docker sandbox (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping the MCP Docker parity legs"
  exit 0
fi
if ! e2e::ensure_docker_test_image; then
  e2e::section "mcp docker sandbox (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

# ---------------------------------------------------------------------------
# Fixture: three named top-level workflows (no `default`), so every tool is a
# non-`default` symbol. `mark` writes a marker into the workspace and returns
# its token; `show` echoes MY_TOKEN; `boom` always fails. Script bodies use
# bash `$VAR` / `$1` forms (Jaiph `${...}` interpolation is rejected there).
# ---------------------------------------------------------------------------
e2e::file "tools.jh" <<'EOF'
script mark_impl = `printf 'marked' > "$JAIPH_WORKSPACE/marker_$1.txt"`
script token_impl = `printf 'MY_TOKEN=[%s]' "${MY_TOKEN:-<unset>}"`

# Write a marker file into the workspace, then return the token.
workflow mark(token) {
  run mark_impl(token)
  return token
}

# Return the MY_TOKEN env var the workflow process sees inside the container.
workflow show() {
  const t = run token_impl()
  return "${t}"
}

# Always fails so the tool call reports an error.
workflow boom() {
  fail "boom-failed"
}
EOF

# Extract `result.content[0].text` (first line) and isError for a response id
# from a captured JSON-RPC stdout stream, and validate every line is JSON-RPC
# (proving no banner/progress leaked). Prints "<iserror>\n<text-first-line>".
# assert_contains is unavoidable for parsing: responses interleave and carry a
# volatile serverInfo.version + absolute run-dir paths.
mcp_field() {
  local file="$1" id="$2"
  python3 - "${file}" "${id}" <<'PY'
import json, sys
lines = [l for l in open(sys.argv[1], encoding="utf-8").read().splitlines() if l.strip()]
want = int(sys.argv[2])
found = None
for line in lines:
    try:
        msg = json.loads(line)
    except json.JSONDecodeError as e:
        sys.exit(f"non-JSON stdout line (banner/progress leak?): {line!r} ({e})")
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        sys.exit(f"non-JSON-RPC line: {line!r}")
    if msg.get("id") == want and "result" in msg:
        found = msg["result"]
if found is None:
    sys.exit(f"no result for id {want}")
print("true" if found.get("isError") else "false")
print(found["content"][0]["text"].splitlines()[0] if found.get("content") else "")
PY
}

# Drive a single tool call against a fresh server. Args: <out-file> <tool>
# <arguments-json> [extra jaiph-mcp argv...]; the DOCKER_* env is applied by
# the caller via the environment.
call_tool() {
  local out="$1" tool="$2" args="$3"; shift 3
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":${args}}}" \
    | jaiph mcp "$@" --workspace "${TEST_DIR}" "${TEST_DIR}/tools.jh" >"${out}" 2>/dev/null
}

export JAIPH_DOCKER_ENABLED=true
export JAIPH_DOCKER_IMAGE="${E2E_DOCKER_TEST_IMAGE}"

# ---------------------------------------------------------------------------
# Leg 1: inplace default — a non-`default` tool runs in-container and its
# workspace effect lands live on the host; its return value round-trips.
# ---------------------------------------------------------------------------
e2e::section "docker inplace default — non-default tool runs in-container, effect lands live"

call_tool "${TEST_DIR}/inplace.txt" mark '{"token":"alpha"}'
{ read -r mark_iserror; read -r mark_text; } <<< "$(mcp_field "${TEST_DIR}/inplace.txt" 2)"
e2e::assert_equals "${mark_iserror}" "false" "docker inplace: mark tool call succeeds"
e2e::assert_equals "${mark_text}" "alpha" "docker inplace: non-default symbol returns its value (not default)"

marker_present="no"
[[ -f "${TEST_DIR}/marker_alpha.txt" ]] && marker_present="yes"
e2e::assert_equals "${marker_present}" "yes" "docker inplace: workspace effect landed live on the host"

# ---------------------------------------------------------------------------
# Leg 2: failure composition — a failing tool yields isError with a host-side
# run-dir pointer discovered from the sandbox runs mount.
# ---------------------------------------------------------------------------
e2e::section "docker inplace — a failing tool composes an isError result with a run-dir pointer"

call_tool "${TEST_DIR}/boom.txt" boom '{}'
{ read -r boom_iserror; read -r boom_text; } <<< "$(mcp_field "${TEST_DIR}/boom.txt" 2)"
e2e::assert_equals "${boom_iserror}" "true" "docker: failing workflow yields isError (not a protocol error)"
e2e::assert_equals "${boom_text}" "workflow boom failed (exit 1)" "docker: failure text names the failure"
# assert_contains: the run-dir pointer carries an absolute per-run host path.
e2e::assert_contains "$(cat "${TEST_DIR}/boom.txt")" "run dir:" "docker: failure result carries a host-side run dir pointer"

# ---------------------------------------------------------------------------
# Leg 3: explicit isolation (JAIPH_INPLACE=0) — the call still runs, but its
# workspace writes are discarded; the host workspace is untouched.
# ---------------------------------------------------------------------------
e2e::section "docker explicit isolation (JAIPH_INPLACE=0) — workspace untouched after the call"

JAIPH_INPLACE=0 call_tool "${TEST_DIR}/iso.txt" mark '{"token":"beta"}'
{ read -r iso_iserror; read -r iso_text; } <<< "$(mcp_field "${TEST_DIR}/iso.txt" 2)"
e2e::assert_equals "${iso_iserror}" "false" "docker isolation: mark tool call still succeeds"
e2e::assert_equals "${iso_text}" "beta" "docker isolation: tool returns its value"

iso_marker_present="no"
[[ -f "${TEST_DIR}/marker_beta.txt" ]] && iso_marker_present="yes"
e2e::assert_equals "${iso_marker_present}" "no" "docker isolation: workspace write was discarded (host untouched)"

# ---------------------------------------------------------------------------
# Leg 4: --env crosses into the per-call container bypassing the allowlist.
# MY_TOKEN is not on ENV_ALLOW_PREFIXES, so it reaches the workflow only via
# --env.
# ---------------------------------------------------------------------------
e2e::section "docker --env — a non-allowlisted key reaches the containerized workflow"

call_tool "${TEST_DIR}/env.txt" show '{}' --env MY_TOKEN=s3cret
{ read -r env_iserror; read -r env_text; } <<< "$(mcp_field "${TEST_DIR}/env.txt" 2)"
e2e::assert_equals "${env_iserror}" "false" "docker --env: show tool call succeeds"
e2e::assert_equals "${env_text}" "MY_TOKEN=[s3cret]" "docker --env: MY_TOKEN crosses the allowlist into the container"
