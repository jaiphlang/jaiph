#!/usr/bin/env bash
#
# serve 1/1 (Docker) — one container serves REST + MCP from outside the container
# ==============================================================================
# The standalone runtime image runs `jaiph serve --host 0.0.0.0` as a long-lived
# HTTP runner; a client on the host (outside the container) drives BOTH transports
# through the published port:
#
#   - GET /healthz                          → unauthenticated liveness
#   - POST /v1/workflows/health/runs?wait   → REST run, bearer-guarded
#   - POST /mcp tools/call health           → MCP Streamable HTTP, same bearer
#   - unauthenticated /v1 and /mcp          → 401 (both surfaces fail closed)
#
# This is the Docker analogue of the Kind test (150): both transports, one
# process, one workflow generation, one auth boundary — exercised from outside
# the container. Non-loopback (0.0.0.0) binds require JAIPH_SERVE_TOKEN, so the
# container is started with one.
#
# Gated: skips unless Docker is available and the local runtime image builds.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"

SERVE_CONTAINER="jaiph-e2e-serve-$$"
serve151::cleanup() {
  docker rm -f "${SERVE_CONTAINER}" >/dev/null 2>&1 || true
  e2e::cleanup
}
trap serve151::cleanup EXIT

e2e::prepare_test_env "serve_transports_docker"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

if ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  e2e::section "serve transports over Docker (skipped — python3/curl unavailable)"
  e2e::skip "python3 and curl are required"
  exit 0
fi
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "serve transports over Docker (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping serve-over-Docker test"
  exit 0
fi
if ! e2e::ensure_docker_test_image; then
  e2e::section "serve transports over Docker (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

# A single exported workflow: the whole file becomes exactly one tool (`health`),
# reachable identically over REST and MCP.
e2e::file "tools.jh" <<'EOF'
# health — proves the served runner is live.
export workflow health() {
  return "ok"
}
EOF

e2e::section "one container serves REST + MCP over the same bearer-guarded port"

serve_token="e2e-$(python3 -c 'import secrets; print(secrets.token_hex(24))')"

# Bind 0.0.0.0 inside the container (non-loopback → JAIPH_SERVE_TOKEN required)
# and publish it to a host-chosen loopback port. --user matches the host UID so
# run artifacts on the /work bind mount are writable. The image bakes
# JAIPH_UNSAFE=true, so the runner executes host-mode inside the container (the
# container is the sandbox) — no nested Docker daemon is needed.
docker run -d --name "${SERVE_CONTAINER}" \
  --user "$(id -u):$(id -g)" \
  -e JAIPH_SERVE_TOKEN="${serve_token}" \
  -p 127.0.0.1::5247 \
  -v "${TEST_DIR}":/work -w /work \
  "${E2E_DOCKER_TEST_IMAGE}" \
  jaiph serve --host 0.0.0.0 --port 5247 /work/tools.jh >/dev/null

hostport="$(docker port "${SERVE_CONTAINER}" 5247/tcp | head -1 | sed -nE 's#.*:([0-9]+)$#\1#p')"
if [[ -z "${hostport}" ]]; then
  printf 'docker logs:\n%s\n' "$(docker logs "${SERVE_CONTAINER}" 2>&1)" >&2
  e2e::fail "could not resolve the published host port for the serve container"
fi
base="http://127.0.0.1:${hostport}"

# Wait for the server to answer /healthz.
ready=""
for _ in $(seq 1 60); do
  if [[ "$(curl -s -o /dev/null -w '%{http_code}' "${base}/healthz")" == "200" ]]; then
    ready="yes"
    break
  fi
  sleep 0.5
done
if [[ -z "${ready}" ]]; then
  printf 'docker logs:\n%s\n' "$(docker logs "${SERVE_CONTAINER}" 2>&1)" >&2
  e2e::fail "serve container did not become healthy"
fi

health_status="$(curl -s "${base}/healthz" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
e2e::assert_equals "${health_status}" "ok" "GET /healthz reports status ok (unauthenticated)"

# Both surfaces fail closed without the token.
rest_unauth="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "${base}/v1/workflows/health/runs?wait=true" -H 'content-type: application/json' -d '{}')"
e2e::assert_equals "${rest_unauth}" "401" "POST /v1 without the bearer token is 401"
mcp_unauth="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${base}/mcp" \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
e2e::assert_equals "${mcp_unauth}" "401" "POST /mcp without the bearer token is 401"

# REST run over HTTP, from outside the container.
rest_status="$(curl -s -X POST "${base}/v1/workflows/health/runs?wait=true" \
  -H "authorization: Bearer ${serve_token}" -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["status"], d["result_text"])')"
e2e::assert_equals "${rest_status}" "succeeded ok" "REST run over Docker succeeds and returns the workflow value"

# MCP tools/call over the same port, same token, same workflow.
mcp_result="$(curl -s -X POST "${base}/mcp" \
  -H "authorization: Bearer ${serve_token}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"health","arguments":{}}}' | python3 -c '
import json, sys
d = json.load(sys.stdin)["result"]
print(d["content"][0]["text"], "err" if d.get("isError") else "ok")
')"
e2e::assert_equals "${mcp_result}" "ok ok" "MCP tools/call over Docker returns the workflow value (isError:false)"
