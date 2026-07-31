#!/usr/bin/env bash
#
# MCP 7/8 — generation lifecycle: hot reload with in-flight calls + drain-then-cancel shutdown
# ============================================================================================
# Black-box coverage of the generation lease model (src/cli/shared/generation.ts)
# through the real `jaiph` entrypoint:
#
#   1. A tool call started before a source reload keeps running against the
#      generation it captured at call start: its second script step (spawned
#      AFTER the reload swapped generations) still finds its scripts dir, and
#      the call returns the OLD generation's value. A call made after the
#      reload returns the NEW generation's value. Stdin closes while both
#      calls are still in flight, so this also proves stdin-close drains
#      active calls before cleanup. Gate files make the ordering
#      deterministic: the first call provably blocks across the reload.
#
#   2. SIGTERM with a call in flight drains: the server stops accepting input,
#      the call finishes normally AFTER the signal (its scripts must still be
#      on disk), its response is delivered, and the server exits 0.
#
#   3. A second SIGTERM cancels: the in-flight run's child process tree is
#      killed (no orphan — the script's recorded PID is gone after exit), the
#      call settles with an isError result, and the server still exits 0.
#
# The server's stdin is a pipe from a feeder subshell (not a FIFO — macOS does
# not reliably deliver FIFO EOF to node), matching how real MCP clients spawn
# stdio servers.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "mcp_generation_lifecycle"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

if ! command -v python3 >/dev/null 2>&1; then
  e2e::fail "python3 required for JSON-RPC stdout validation"
fi

INIT_REQ='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}'

# Wait until a pattern appears in a file (server stderr, pid files, ...).
wait_for() {
  local label="$1" path="$2" pattern="$3"
  for _ in $(seq 1 100); do
    if [[ -f "${path}" ]] && grep -q "${pattern}" "${path}" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  [[ -f "${path}" ]] && printf 'file was:\n%s\n' "$(cat "${path}")" >&2
  e2e::fail "${label}"
}

# Extract `text` + `isError` of one tools/call response by id from a JSON-RPC
# stdout capture. Prints "<isError>\n<text first line>".
response_fields() {
  python3 - "$1" "$2" <<'PY'
import json, sys

wanted = int(sys.argv[2])
for line in open(sys.argv[1], encoding="utf-8"):
    if not line.strip():
        continue
    msg = json.loads(line)
    if msg.get("id") == wanted and "result" in msg:
        r = msg["result"]
        print("true" if r.get("isError") else "false")
        print(r["content"][0]["text"].splitlines()[0])
        sys.exit(0)
sys.exit(f"no result for id {wanted}")
PY
}

# `slow` runs two script steps: `pause` blocks on a gate file (and records that
# the call started via a pid file), then `stamp` — spawned only after the gate
# appears — echoes this generation's marker.
write_fixture() {
  local file="$1" marker="$2" pidfile="$3" gate="$4"
  cat > "${file}" <<EOF
script pause = \`echo \$\$ > "${pidfile}"; while [ ! -f "${gate}" ]; do sleep 0.2; done\`
script stamp = \`echo "${marker}"\`

# Waits for the gate file, then reports its generation's marker.
workflow slow() {
  run pause()
  const out = run stamp()
  return out
}
EOF
}

# ---------------------------------------------------------------------------
# 1. A slow call spans a hot reload and keeps its generation's scripts
# ---------------------------------------------------------------------------
e2e::section "in-flight call survives a hot reload on the generation it started under"

gate1="${TEST_DIR}/gate1"
pid1="${TEST_DIR}/pause1.pid"
pid2="${TEST_DIR}/pause2.pid"
reload_ack="${TEST_DIR}/reload_ack"
write_fixture "${TEST_DIR}/tools.jh" "generation-one" "${pid1}" "${gate1}"

out1="${TEST_DIR}/mcp1.out"
err1="${TEST_DIR}/mcp1.err"
# The feeder issues id:4 only once the driver has confirmed the swap is live
# (the `reload_ack` marker), then exits — closing stdin while BOTH calls are
# still gated, so the drain must keep the generations' scripts alive until the
# gate opens and the calls settle. The handshake is one-sided on purpose: an
# independent per-side poll on "sources reloaded" let id:4 race ahead of the
# swap under load and bind to the superseded generation (returning the OLD
# marker); gating id:4 on the driver-set marker makes the ordering exact.
(
  printf '%s\n' "${INIT_REQ}"
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"slow","arguments":{}}}'
  for _ in $(seq 1 600); do [[ -f "${reload_ack}" ]] && break; sleep 0.1; done
  printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"slow","arguments":{}}}'
) | jaiph mcp "${TEST_DIR}/tools.jh" >"${out1}" 2>"${err1}" &
E2E_SERVER_PID="$!"

# The first call is provably in flight (its first script step wrote the pid
# file) before the source is rewritten.
wait_for "gen-1 call started" "${pid1}" "[0-9]"
write_fixture "${TEST_DIR}/tools.jh" "generation-two" "${pid2}" "${gate1}"
wait_for "sources reloaded" "${err1}" "sources reloaded"

# The swap is confirmed live; release id:4, then wait until it too is provably
# in flight on the NEW generation (its pause step wrote the new pid file) — so
# stdin closes with BOTH calls gated, and id:4 can never have bound to the
# superseded generation.
touch "${reload_ack}"
wait_for "gen-2 call started" "${pid2}" "[0-9]"

# Only now — with both calls gated on live generations and stdin about to
# close — unblock them; the old call's `stamp` step spawns from the superseded
# generation's scripts dir.
touch "${gate1}"

mcp1_exit=0
wait "${E2E_SERVER_PID}" || mcp1_exit=$?
E2E_SERVER_PID=""
e2e::assert_equals "${mcp1_exit}" "0" "server 1 exits 0 after stdin close drains both calls"

fields="$(response_fields "${out1}" 3)" || { cat "${out1}" "${err1}" >&2; e2e::fail "no response for id 3"; }
{ read -r p_iserror; read -r p_text; } <<< "${fields}"
e2e::assert_equals "${p_iserror}" "false" "call started before the reload succeeds"
e2e::assert_equals "${p_text}" "generation-one" "call started before the reload ran the OLD generation's scripts"

fields="$(response_fields "${out1}" 4)" || { cat "${out1}" "${err1}" >&2; e2e::fail "no response for id 4"; }
{ read -r p_iserror; read -r p_text; } <<< "${fields}"
e2e::assert_equals "${p_iserror}" "false" "call made after the reload succeeds"
e2e::assert_equals "${p_text}" "generation-two" "call made after the reload ran the NEW generation's scripts"

# ---------------------------------------------------------------------------
# 2. SIGTERM drains: the in-flight call finishes after the signal, exit 0
# ---------------------------------------------------------------------------
e2e::section "SIGTERM drains the in-flight call before cleanup"

gate2="${TEST_DIR}/gate2"
pid2="${TEST_DIR}/pause_drain.pid"
done2="${TEST_DIR}/done2"
write_fixture "${TEST_DIR}/tools_drain.jh" "drain-ok" "${pid2}" "${gate2}"

out2="${TEST_DIR}/mcp2.out"
err2="${TEST_DIR}/mcp2.err"
# The feeder holds stdin open until the test finishes, so shutdown is driven
# by the signal alone.
(
  printf '%s\n' "${INIT_REQ}"
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"slow","arguments":{}}}'
  for _ in $(seq 1 300); do [[ -f "${done2}" ]] && break; sleep 0.2; done
) | jaiph mcp "${TEST_DIR}/tools_drain.jh" >"${out2}" 2>"${err2}" &
E2E_SERVER_PID="$!"

wait_for "drain call started" "${pid2}" "[0-9]"
kill -TERM "${E2E_SERVER_PID}"
wait_for "drain notice logged" "${err2}" "draining in-flight calls"
# The call completes only after the signal: its second script step must still
# find the generation's scripts on disk.
touch "${gate2}"

mcp2_exit=0
wait "${E2E_SERVER_PID}" || mcp2_exit=$?
E2E_SERVER_PID=""
touch "${done2}"
e2e::assert_equals "${mcp2_exit}" "0" "server 2 exits 0 after draining"

fields="$(response_fields "${out2}" 3)" || { cat "${out2}" "${err2}" >&2; e2e::fail "no response for drained call"; }
{ read -r p_iserror; read -r p_text; } <<< "${fields}"
e2e::assert_equals "${p_iserror}" "false" "drained call completed successfully after SIGTERM"
e2e::assert_equals "${p_text}" "drain-ok" "drained call ran its remaining script step after SIGTERM"

pause_pid="$(cat "${pid2}")"
if kill -0 "${pause_pid}" 2>/dev/null; then
  e2e::fail "drained call's script process ${pause_pid} outlived the server"
fi
e2e::pass "no orphaned script process after drain"

# ---------------------------------------------------------------------------
# 3. Second SIGTERM cancels: child tree killed, error result, exit 0
# ---------------------------------------------------------------------------
e2e::section "second SIGTERM cancels in-flight calls without orphaning children"

pid3="${TEST_DIR}/pause_cancel.pid"
done3="${TEST_DIR}/done3"
cat > "${TEST_DIR}/tools_cancel.jh" <<EOF
script hang_forever = \`echo \$\$ > "${pid3}"; sleep 300\`

# Hangs until cancelled.
workflow hang() {
  run hang_forever()
  return "unreachable"
}
EOF

out3="${TEST_DIR}/mcp3.out"
err3="${TEST_DIR}/mcp3.err"
(
  printf '%s\n' "${INIT_REQ}"
  printf '%s\n' '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"hang","arguments":{}}}'
  for _ in $(seq 1 300); do [[ -f "${done3}" ]] && break; sleep 0.2; done
) | jaiph mcp "${TEST_DIR}/tools_cancel.jh" >"${out3}" 2>"${err3}" &
E2E_SERVER_PID="$!"

wait_for "hanging call started" "${pid3}" "[0-9]"
kill -TERM "${E2E_SERVER_PID}"
wait_for "drain notice logged" "${err3}" "draining in-flight calls"
kill -TERM "${E2E_SERVER_PID}"
wait_for "cancel notice logged" "${err3}" "cancelling in-flight calls"

mcp3_exit=0
wait "${E2E_SERVER_PID}" || mcp3_exit=$?
E2E_SERVER_PID=""
touch "${done3}"
e2e::assert_equals "${mcp3_exit}" "0" "server 3 exits 0 after cancelling"

fields="$(response_fields "${out3}" 5)" || { cat "${out3}" "${err3}" >&2; e2e::fail "no response for cancelled call"; }
{ read -r p_iserror; read -r p_text; } <<< "${fields}"
e2e::assert_equals "${p_iserror}" "true" "cancelled call settles with an isError result"
# assert_contains: the narrative is timing-dependent ("terminated by signal
# SIGINT" vs "failed (exit N)" if the runner fields the signal itself), so full
# equality is not feasible; the response must at least name the failed workflow.
e2e::assert_contains "${p_text}" "workflow hang" "cancelled call names the failed workflow"

hang_pid="$(cat "${pid3}")"
if kill -0 "${hang_pid}" 2>/dev/null; then
  kill -9 "${hang_pid}" 2>/dev/null || true
  e2e::fail "cancelled call's script process ${hang_pid} outlived the server (orphan)"
fi
e2e::pass "no orphaned script process after cancel"
