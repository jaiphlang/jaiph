#!/usr/bin/env bash
#
# MCP 6/8 — `jaiph mcp` scripted stdio session + `jaiph run` launch-path regression
# =================================================================================
# Black-box coverage through the real `jaiph` entrypoint (design:
# design/2026-07-14-mcp-server.md -> "Testing"):
#
#   1. `jaiph mcp <fixture.jh>` is driven as a child process over stdio with a
#      scripted JSON-RPC session — initialize, tools/list, a successful
#      tools/call (param round-trip through a workflow `return`), and a failing
#      tools/call — then stdin is closed. Asserts: every stdout line is valid
#      JSON-RPC 2.0 (no banner / progress leakage — banners go to stderr), the
#      successful tool result text equals the workflow's return value, the
#      failing workflow yields isError:true (not a protocol error), and the
#      server shuts down with exit 0 on stdin close.
#
#   2. Regression: `jaiph run <fixture-with-default>` still exits 0 and prints
#      the return value. The launch path (src/runtime/kernel/workflow-launch.ts)
#      is shared by `run` and `mcp` and previously hardcoded the `default`
#      symbol; this leg pins the `default` direction while the mcp leg above
#      pins the named-symbol direction.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "mcp_server_session"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

if ! command -v python3 >/dev/null 2>&1; then
  e2e::fail "python3 required for JSON-RPC stdout validation"
fi

# ---------------------------------------------------------------------------
# Fixture 1: MCP server file — two named top-level workflows, no `default`.
# echo_msg round-trips its param through `return`; boom always fails.
# ---------------------------------------------------------------------------
e2e::file "tools.jh" <<'EOF'
# Echo the message argument straight back as the return value.
workflow echo_msg(message) {
  return message
}

# Always fails so the tool call reports an error.
workflow boom() {
  fail "boom-failed"
}
EOF

e2e::section "jaiph mcp serves a scripted JSON-RPC session over stdio"

mcp_out="${TEST_DIR}/mcp_stdout.txt"
mcp_err="${TEST_DIR}/mcp_stderr.txt"

# Drive the server as a child process: feed the full request sequence on stdin,
# then EOF (closing stdin) triggers the exit-0 shutdown after in-flight calls
# settle. Requests carry explicit ids so responses can be matched regardless of
# concurrent-handling interleave.
mcp_exit=0
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo_msg","arguments":{"message":"round-trip-value"}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"boom","arguments":{}}}' \
  | jaiph mcp "${TEST_DIR}/tools.jh" >"${mcp_out}" 2>"${mcp_err}" || mcp_exit=$?

e2e::assert_equals "${mcp_exit}" "0" "jaiph mcp exits 0 on stdin close"

# Validate every stdout line is well-formed JSON-RPC 2.0 (this is how we prove
# no banner / progress line leaked onto stdout — either would fail to parse)
# and extract the fields the acceptance bullets pin. Responses are matched by
# id since concurrent handling may interleave them.
# assert_contains/full-equality is not feasible here: the response set includes
# a volatile serverInfo.version and an absolute per-run `run dir:` path, and
# ordering may interleave — so we assert the meaningful fields for equality.
parsed_raw=""
py_exit=0
parsed_raw="$(python3 - "${mcp_out}" 2>&1 <<'PY'
import json, sys

lines = [l for l in open(sys.argv[1], encoding="utf-8").read().splitlines() if l.strip()]
by_id = {}
for i, line in enumerate(lines, 1):
    try:
        msg = json.loads(line)
    except json.JSONDecodeError as e:
        sys.exit(f"stdout line {i} is not valid JSON (banner/progress leak?): {line!r} ({e})")
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        sys.exit(f"stdout line {i} is not JSON-RPC 2.0: {line!r}")
    if "id" in msg:
        by_id[msg["id"]] = msg

def result(i):
    m = by_id.get(i)
    if m is None or "result" not in m:
        sys.exit(f"missing result for id {i}")
    return m["result"]

echo = result(3)
boom = result(4)

print(len(lines))
print(echo["content"][0]["text"])
print("true" if echo.get("isError") else "false")
print("true" if boom.get("isError") else "false")
print(boom["content"][0]["text"].splitlines()[0])
PY
)" || py_exit=$?

if [[ ${py_exit} -ne 0 ]]; then
  printf '%s\n' "${parsed_raw}" >&2
  printf 'stdout was:\n%s\n' "$(cat "${mcp_out}")" >&2
  e2e::fail "jaiph mcp stdout is not valid JSON-RPC"
fi

# Fixed-order, newline-free fields (avoid `mapfile` — macOS ships bash 3.2).
{
  read -r p_line_count
  read -r p_echo_text
  read -r p_echo_iserror
  read -r p_boom_iserror
  read -r p_boom_first_line
} <<< "${parsed_raw}"

e2e::assert_equals "${p_line_count}" "4" "stdout has exactly 4 JSON-RPC responses (no leakage)"
e2e::assert_equals "${p_echo_text}" "round-trip-value" "tool result text equals the workflow return value"
e2e::assert_equals "${p_echo_iserror}" "false" "successful tool call reports isError:false"
e2e::assert_equals "${p_boom_iserror}" "true" "failing workflow yields isError:true (not a protocol error)"
e2e::assert_equals "${p_boom_first_line}" "workflow boom failed (exit 1)" "failing tool result names the failure"

# ---------------------------------------------------------------------------
# Fixture 2 + regression leg: the shared launch path must still run `default`.
# ---------------------------------------------------------------------------
e2e::section "jaiph run on a default workflow still exits 0 and prints the return value"

e2e::file "greet.jh" <<'EOF'
# Greet the named person.
workflow default(name) {
  return "Hello, ${name}"
}
EOF

run_exit=0
run_out="$(e2e::run "greet.jh" Adam)" || run_exit=$?
e2e::assert_equals "${run_exit}" "0" "jaiph run default exits 0"

e2e::expect_stdout "${run_out}" <<'EOF'

Jaiph: Running greet.jh

workflow default (name="Adam")

✓ PASS workflow default (<time>)

Hello, Adam
EOF
