#!/usr/bin/env bash
#
# k8s 1/1 — docs/deploy/k8s.yaml deploys, hardens, and completes a run
# =====================================================================
# The dry-run gate in CI only proves the manifest parses. This test proves the
# deployment contract on a real (kind) cluster:
#
#   - the manifest ships no credentials: the pod is blocked in
#     CreateContainerConfigError until the operator creates the external
#     `jaiph-credentials` Secret (JAIPH_SERVE_TOKEN), then starts;
#   - the pod is hardened: non-root fixed UID, no privilege escalation, all
#     capabilities dropped, RuntimeDefault seccomp, read-only root filesystem,
#     no service-account token mounted — each pinned by an assertion that
#     fails if the manifest field is removed;
#   - a real run completes: the health workflow is invoked over HTTP with
#     bearer auth, lands its journal on the writable runs volume
#     (JAIPH_RUNS_DIR) while /work stays read-only, and the events endpoint
#     byte-matches that journal.
#
# Gated: skips unless docker, kind, and kubectl are available. Set
# JAIPH_E2E_KIND_CLUSTER to reuse an existing kind cluster (CI does); without
# it the test creates and deletes its own. The user kubeconfig is never
# touched — kubectl runs against a private kubeconfig in the test dir.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"

K8S_MANIFEST="${ROOT_DIR}/docs/deploy/k8s.yaml"
K8S_NAMESPACE="jaiph-e2e"
K8S_CLUSTER="${JAIPH_E2E_KIND_CLUSTER:-}"
K8S_OWNS_CLUSTER=0
K8S_PORT_FORWARD_PID=""

k8s::cleanup() {
  if [[ -n "${K8S_PORT_FORWARD_PID}" ]]; then
    kill "${K8S_PORT_FORWARD_PID}" >/dev/null 2>&1 || true
    wait "${K8S_PORT_FORWARD_PID}" 2>/dev/null || true
    K8S_PORT_FORWARD_PID=""
  fi
  if [[ "${K8S_OWNS_CLUSTER}" == "1" ]]; then
    kind delete cluster --name "${K8S_CLUSTER}" >/dev/null 2>&1 || true
  elif [[ -n "${K8S_CLUSTER}" && -n "${KUBECONFIG:-}" && -f "${KUBECONFIG}" ]]; then
    # Shared cluster (CI): remove only what this test created.
    kubectl delete namespace "${K8S_NAMESPACE}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  e2e::cleanup
}
trap k8s::cleanup EXIT

e2e::prepare_test_env "k8s_deploy"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

for cmd in kind kubectl python3 curl; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    e2e::section "k8s deploy manifest (skipped — ${cmd} unavailable)"
    e2e::skip "${cmd} is not available, skipping k8s deploy test"
    exit 0
  fi
done
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  e2e::section "k8s deploy manifest (skipped — Docker unavailable)"
  e2e::skip "Docker is not available, skipping k8s deploy test"
  exit 0
fi
if ! e2e::ensure_docker_test_image; then
  e2e::section "k8s deploy manifest (skipped — test image build failed)"
  e2e::skip "Could not build local Docker test image"
  exit 0
fi

e2e::section "manifest ships no applyable credentials"

# The base manifest must not contain a Secret (the credential contract is an
# external `kubectl create secret`); a reintroduced placeholder fails here.
if grep -q "^kind: Secret" "${K8S_MANIFEST}"; then
  e2e::fail "docs/deploy/k8s.yaml must not ship a Secret manifest (external Secret contract)"
fi
if grep -qi "replace-me" "${K8S_MANIFEST}"; then
  e2e::fail "docs/deploy/k8s.yaml must not ship placeholder credential values"
fi
e2e::pass "no Secret manifest / placeholder credentials in docs/deploy/k8s.yaml"

e2e::section "kind cluster + image load"

export KUBECONFIG="${TEST_DIR}/kubeconfig"
if [[ -n "${K8S_CLUSTER}" ]]; then
  kind export kubeconfig --name "${K8S_CLUSTER}" --kubeconfig "${KUBECONFIG}"
else
  K8S_CLUSTER="jaiph-e2e-$$"
  K8S_OWNS_CLUSTER=1
  kind create cluster --name "${K8S_CLUSTER}" --kubeconfig "${KUBECONFIG}" --wait 120s >/dev/null
fi
kind load docker-image "${E2E_DOCKER_TEST_IMAGE}" --name "${K8S_CLUSTER}" >/dev/null
e2e::pass "cluster ${K8S_CLUSTER} ready with ${E2E_DOCKER_TEST_IMAGE} loaded"

kubectl create namespace "${K8S_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kc() { kubectl -n "${K8S_NAMESPACE}" "$@"; }

e2e::section "external Secret contract blocks startup until the operator provides it"

# Apply the manifest verbatim except the image line: the test must run the
# locally built image, and the manifest itself instructs pinning your own.
sed "s|image: ghcr.io/jaiphlang/jaiph-runtime:nightly|image: ${E2E_DOCKER_TEST_IMAGE}|" \
  "${K8S_MANIFEST}" | kc apply -f - >/dev/null

# The secretRef must be required (`optional` unset), and without the Secret
# the pod must be held in CreateContainerConfigError — never a running,
# unauthenticated server.
optional="$(kc get deployment jaiph-runner \
  -o jsonpath='{.spec.template.spec.containers[0].envFrom[0].secretRef.optional}')"
e2e::assert_equals "${optional}" "" "jaiph-credentials secretRef is required (optional unset)"

blocked=""
for _ in $(seq 1 60); do
  blocked="$(kc get pods -l app=jaiph-runner \
    -o jsonpath='{.items[0].status.containerStatuses[0].state.waiting.reason}' 2>/dev/null || true)"
  if [[ "${blocked}" == "CreateContainerConfigError" ]]; then
    break
  fi
  sleep 2
done
e2e::assert_equals "${blocked}" "CreateContainerConfigError" \
  "pod is blocked until the external jaiph-credentials Secret exists"

serve_token="e2e-$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
kc create secret generic jaiph-credentials \
  --from-literal=JAIPH_SERVE_TOKEN="${serve_token}" >/dev/null
kc rollout status deployment/jaiph-runner --timeout=240s >/dev/null
e2e::pass "pod started once the Secret was created"

e2e::section "pod hardening is applied and effective"

pod="$(kc get pods -l app=jaiph-runner --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}')"

# Manifest-derived spec fields: each assertion fails if the corresponding
# hardening line is removed from docs/deploy/k8s.yaml.
spec_fields="$(kc get pod "${pod}" -o jsonpath='{.spec.securityContext.runAsNonRoot} {.spec.securityContext.runAsUser} {.spec.securityContext.seccompProfile.type} {.spec.automountServiceAccountToken} {.spec.containers[0].securityContext.allowPrivilegeEscalation} {.spec.containers[0].securityContext.readOnlyRootFilesystem} {.spec.containers[0].securityContext.capabilities.drop[0]}')"
e2e::assert_equals "${spec_fields}" "true 10001 RuntimeDefault false false true ALL" \
  "runAsNonRoot=true runAsUser=10001 seccomp=RuntimeDefault automountSAToken=false allowPrivilegeEscalation=false readOnlyRootFilesystem=true capabilities.drop=ALL"

# Effective in the running container, not just declared.
e2e::assert_equals "$(kc exec "${pod}" -- id -u)" "10001" "container runs as UID 10001 (non-root)"
e2e::assert_equals \
  "$(kc exec "${pod}" -- sh -c 'test -e /var/run/secrets/kubernetes.io/serviceaccount/token && echo mounted || echo absent')" \
  "absent" "default service-account token is not mounted"
e2e::assert_equals \
  "$(kc exec "${pod}" -- sh -c 'touch /usr/local/e2e-probe 2>/dev/null && echo writable || echo readonly')" \
  "readonly" "root filesystem is read-only"
e2e::assert_equals \
  "$(kc exec "${pod}" -- sh -c 'touch /work/e2e-probe 2>/dev/null && echo writable || echo readonly')" \
  "readonly" "workflow sources under /work are read-only"

e2e::section "authenticated HTTP run lands its journal on the writable runs volume"

pf_out="${TEST_DIR}/port_forward.txt"
: >"${pf_out}"
kc port-forward svc/jaiph-runner :80 >"${pf_out}" 2>&1 &
K8S_PORT_FORWARD_PID="$!"
port=""
for _ in $(seq 1 50); do
  port="$(sed -nE 's#^Forwarding from 127\.0\.0\.1:([0-9]+).*#\1#p' "${pf_out}" | head -1)"
  if [[ -n "${port}" ]]; then
    break
  fi
  sleep 0.2
done
if [[ -z "${port}" ]]; then
  printf 'port-forward output:\n%s\n' "$(cat "${pf_out}")" >&2
  e2e::fail "kubectl port-forward did not report a local port"
fi
base="http://127.0.0.1:${port}"

health_status="$(curl -s "${base}/healthz" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
e2e::assert_equals "${health_status}" "ok" "GET /healthz reports status ok"

unauth_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "${base}/v1/workflows/health/runs?wait=true" -H 'content-type: application/json' -d '{}')"
e2e::assert_equals "${unauth_code}" "401" "POST without the bearer token is rejected with 401"

run_json="$(curl -s -X POST "${base}/v1/workflows/health/runs?wait=true" \
  -H "authorization: Bearer ${serve_token}" -H 'content-type: application/json' -d '{}')"
run_fields="$(printf '%s' "${run_json}" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d["status"])
print(d["result_text"])
print(d["run_id"])
print(d["run_dir"])
')"
{
  read -r p_status
  read -r p_result
  read -r p_run_id
  read -r p_run_dir
} <<< "${run_fields}"
e2e::assert_equals "${p_status}" "succeeded" "health run status is succeeded"
e2e::assert_equals "${p_result}" "ok" "health result_text is the workflow return value"
case "${p_run_dir}" in
  /jaiph/runs/*) e2e::pass "run_dir ${p_run_dir} is on the writable runs volume (JAIPH_RUNS_DIR)" ;;
  *) e2e::fail "run_dir ${p_run_dir} is not under /jaiph/runs" ;;
esac

# The durable journal on the runs volume is the source of truth; the events
# endpoint must serve it verbatim (full-content equality).
journal="$(kc exec "${pod}" -- cat "${p_run_dir}/run_summary.jsonl")"
events="$(curl -s "${base}/v1/runs/${p_run_id}/events" -H "authorization: Bearer ${serve_token}")"
e2e::assert_equals "${events}" "${journal}" \
  "GET events (NDJSON) byte-matches run_summary.jsonl read from the runs volume"

e2e::section "the same pod serves MCP Streamable HTTP from outside, behind the same bearer auth"

# Both transports are one process against one generation. The MCP surface obeys
# the same bearer boundary as /v1, and a tools/call over HTTP runs the same
# workflow and lands in the same run registry as the REST call above.
mcp_unauth_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${base}/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
e2e::assert_equals "${mcp_unauth_code}" "401" "POST /mcp without the bearer token is rejected with 401"

mcp_ver="$(curl -s -X POST "${base}/mcp" \
  -H "authorization: Bearer ${serve_token}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["protocolVersion"])')"
e2e::assert_equals "${mcp_ver}" "2025-06-18" "authenticated POST /mcp initialize negotiates the protocol version"

mcp_result="$(curl -s -X POST "${base}/mcp" \
  -H "authorization: Bearer ${serve_token}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"health","arguments":{}}}' | python3 -c '
import json, sys
d = json.load(sys.stdin)["result"]
print(d["content"][0]["text"])
print("true" if d.get("isError") else "false")
')"
{
  read -r p_mcp_text
  read -r p_mcp_iserror
} <<< "${mcp_result}"
e2e::assert_equals "${p_mcp_text}" "ok" "authenticated POST /mcp tools/call returns the workflow return value"
e2e::assert_equals "${p_mcp_iserror}" "false" "POST /mcp tools/call reports isError:false on success"
