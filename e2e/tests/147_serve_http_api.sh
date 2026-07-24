#!/usr/bin/env bash
#
# serve 1/1 — `jaiph serve` HTTP API end-to-end (host mode)
# ========================================================
# Black-box coverage through the real `jaiph` entrypoint (design:
# design/2026-07-23-serve-http-api.md -> "Testing"):
#
#   Start `jaiph serve --port 0 <fixture.jh>` as a background child, discover
#   the bound port from its stderr startup line, then drive the HTTP surface
#   with curl:
#     - GET /healthz            → {status:"ok", ...} unauthenticated
#     - GET /openapi.json       → OpenAPI 3.1.0 with a per-workflow path
#     - POST .../greet/runs?wait=true → succeeded run round-trips the return value
#     - POST .../boom/runs?wait=true  → HTTP 200 with status:"failed" (a workflow
#                                       failure is NOT an HTTP error)
#   Assertions compare the meaningful JSON fields for equality (the run object
#   carries a volatile run_dir + timestamps, so full-body equality is not
#   feasible — hence field-level checks, per the e2e assertion policy).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "serve_http_api"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

if ! command -v python3 >/dev/null 2>&1; then
  e2e::fail "python3 required for JSON response validation"
fi
if ! command -v curl >/dev/null 2>&1; then
  e2e::fail "curl required for HTTP e2e"
fi

e2e::file "tools.jh" <<'EOF'
# Greets the given name.
workflow greet(name) {
  return "hello ${name}"
}

# Always fails so the run reports a failure.
workflow boom() {
  fail "boom-failed"
}

script publish = `printf 'artifact-payload' > "$JAIPH_ARTIFACTS_DIR/result.txt"`
# Publishes a file into the run's artifacts dir.
workflow make_artifact() {
  run publish()
  return "published"
}
EOF

e2e::section "jaiph serve exposes an HTTP API over host-mode runs"

serve_err="${TEST_DIR}/serve_stderr.txt"
: >"${serve_err}"

# `--port 0` binds a free port; the startup line on stderr carries it.
jaiph serve --port 0 "${TEST_DIR}/tools.jh" >/dev/null 2>"${serve_err}" &
# Reuse the harness's server-pid slot so e2e::cleanup tears the server down.
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

# --- /healthz (unauthenticated) ---
health="$(curl -s "${base}/healthz")"
health_status="$(printf '%s' "${health}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
e2e::assert_equals "${health_status}" "ok" "GET /healthz reports status ok"

# --- /openapi.json (unauthenticated, OpenAPI 3.1 with a per-workflow path) ---
openapi="$(curl -s "${base}/openapi.json")"
openapi_fields="$(printf '%s' "${openapi}" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d["openapi"])
print("yes" if "/v1/workflows/greet/runs" in d["paths"] else "no")
')"
{
  read -r p_openapi_version
  read -r p_has_greet_path
} <<< "${openapi_fields}"
e2e::assert_equals "${p_openapi_version}" "3.1.0" "GET /openapi.json is OpenAPI 3.1.0"
e2e::assert_equals "${p_has_greet_path}" "yes" "/openapi.json has a concrete path for the greet workflow"

# --- POST greet ?wait=true → succeeded, return value round-trips ---
greet="$(curl -s -X POST "${base}/v1/workflows/greet/runs?wait=true" \
  -H 'content-type: application/json' -d '{"name":"world"}')"
greet_fields="$(printf '%s' "${greet}" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d["status"])
print(d["result_text"])
print("yes" if d.get("run_dir") else "no")
')"
{
  read -r p_greet_status
  read -r p_greet_text
  read -r p_greet_has_rundir
} <<< "${greet_fields}"
e2e::assert_equals "${p_greet_status}" "succeeded" "greet run status is succeeded"
e2e::assert_equals "${p_greet_text}" "hello world" "greet result_text is the workflow return value"
e2e::assert_equals "${p_greet_has_rundir}" "yes" "greet run object carries a run_dir"

# --- POST boom ?wait=true → HTTP 200 with status failed (not an HTTP error) ---
boom_body="${TEST_DIR}/boom_body.json"
boom_code="$(curl -s -o "${boom_body}" -w '%{http_code}' -X POST \
  "${base}/v1/workflows/boom/runs?wait=true" -H 'content-type: application/json' -d '{}')"
e2e::assert_equals "${boom_code}" "200" "a failing workflow is HTTP 200 (workflow failure is not an HTTP error)"
boom_status="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "${boom_body}")"
e2e::assert_equals "${boom_status}" "failed" "boom run status is failed"

# --- GET /v1/workflows lists all exposed workflows ---
workflows="$(curl -s "${base}/v1/workflows" | python3 -c '
import json, sys
names = sorted(w["name"] for w in json.load(sys.stdin)["workflows"])
print(",".join(names))
')"
e2e::assert_equals "${workflows}" "boom,greet,make_artifact" "GET /v1/workflows lists all workflows"

# --- GET /v1/runs/{id}/events (NDJSON) mirrors the durable journal ---
# The greet run above returned a run object; re-run it capturing the id, then
# byte-compare the events endpoint against the on-disk run_summary.jsonl.
run_json="$(curl -s -X POST "${base}/v1/workflows/greet/runs?wait=true" \
  -H 'content-type: application/json' -d '{"name":"events"}')"
run_id="$(printf '%s' "${run_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')"
run_dir="$(printf '%s' "${run_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["run_dir"])')"

events_body="${TEST_DIR}/events.ndjson"
curl -s "${base}/v1/runs/${run_id}/events" -o "${events_body}"
# Full-content equality: the NDJSON stream is the journal, verbatim.
e2e::assert_equals "$(cat "${events_body}")" "$(cat "${run_dir}/run_summary.jsonl")" \
  "GET events (NDJSON) byte-matches the run's run_summary.jsonl"

# --- artifacts: list + byte-identical download, traversal is rejected ---
art_json="$(curl -s -X POST "${base}/v1/workflows/make_artifact/runs?wait=true" \
  -H 'content-type: application/json' -d '{}')"
art_id="$(printf '%s' "${art_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')"

art_list="$(curl -s "${base}/v1/runs/${art_id}/artifacts" | python3 -c '
import json, sys
print(",".join(a["path"] for a in json.load(sys.stdin)["artifacts"]))
')"
e2e::assert_equals "${art_list}" "result.txt" "GET artifacts lists the published file"

art_file="${TEST_DIR}/downloaded.txt"
curl -s "${base}/v1/runs/${art_id}/artifacts/result.txt" -o "${art_file}"
e2e::assert_equals "$(cat "${art_file}")" "artifact-payload" "artifact downloads byte-identically"

# A URL-encoded `..` traversal escaping artifacts/ is a 404 (no bytes served).
trav_code="$(curl -s -o /dev/null -w '%{http_code}' \
  "${base}/v1/runs/${art_id}/artifacts/%2e%2e%2frun_summary.jsonl")"
e2e::assert_equals "${trav_code}" "404" "artifact path traversal is rejected with 404"
