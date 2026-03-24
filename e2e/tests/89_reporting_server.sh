#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"

e2e::prepare_test_env "reporting_server"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

REPORT_PORT="${JAIPH_REPORT_PORT:-19887}"
REPORT_PID=""

cleanup_report() {
  if [[ -n "${REPORT_PID}" ]]; then
    kill "${REPORT_PID}" >/dev/null 2>&1 || true
    wait "${REPORT_PID}" 2>/dev/null || true
    REPORT_PID=""
  fi
}

trap 'cleanup_report; e2e::cleanup' EXIT

e2e::section "reporting server: discovery, tree, logs, aggregate, live polling"

e2e::file "reporting_probe.jh" <<'EOF'
workflow default {
  echo "agg-line"
}
EOF

jaiph run "${TEST_DIR}/reporting_probe.jh"

RUNS="${TEST_DIR}/.jaiph/runs"
[[ -d "${RUNS}" ]] || e2e::fail "expected .jaiph/runs"

node "${ROOT_DIR}/dist/src/reporting/cli.js" --workspace "${TEST_DIR}" --port "${REPORT_PORT}" --host 127.0.0.1 --runs-dir "${RUNS}" --poll-ms 200 &
REPORT_PID=$!

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${REPORT_PORT}/api/runs" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

JSON="$(curl -fsS "http://127.0.0.1:${REPORT_PORT}/api/runs?limit=20")"
RUN_PATH="$(echo "${JSON}" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); if (!j.total||j.total<1) process.exit(1); process.stdout.write(j.runs[0].path);')"
[[ -n "${RUN_PATH}" ]] || e2e::fail "run path empty"

ENC="$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "${RUN_PATH}")"
TREE="$(curl -fsS "http://127.0.0.1:${REPORT_PORT}/api/runs/${ENC}/tree")"
echo "${TREE}" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); if (!(j.steps&&j.steps.length)) process.exit(1);'

AGG="$(curl -fsS "http://127.0.0.1:${REPORT_PORT}/api/runs/${ENC}/aggregate")"
e2e::assert_contains "${AGG}" "agg-line" "aggregate includes step stdout"

STEP_ID="$(echo "${TREE}" | node -e '
const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
function walk(nodes) {
  for (const x of nodes || []) {
    if (x.out_file) {
      process.stdout.write(x.id);
      return;
    }
    if (x.children && x.children.length) walk(x.children);
  }
}
walk(j.steps);
')"
OUT_FILE="$(echo "${TREE}" | node -e '
const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
function walk(nodes) {
  for (const x of nodes || []) {
    if (x.out_file) {
      process.stdout.write(x.out_file);
      return;
    }
    if (x.children && x.children.length) walk(x.children);
  }
}
walk(j.steps);
')"
[[ -n "${STEP_ID}" ]] || e2e::fail "shell step id"
[[ -f "${OUT_FILE}" ]] || e2e::fail "out file missing"

OUT_JSON="$(curl -fsS "http://127.0.0.1:${REPORT_PORT}/api/runs/${ENC}/steps/${STEP_ID}/output")"
e2e::assert_contains "${OUT_JSON}" "agg-line" "embedded output API includes stdout text"

RAW="$(curl -fsS "http://127.0.0.1:${REPORT_PORT}/api/runs/${ENC}/steps/${STEP_ID}/logs?stream=out")"
e2e::assert_contains "${RAW}" "agg-line" "raw log stream returns .out body"

e2e::section "reporting server: active run updates when summary is appended"

LIVE_ROOT="${TEST_DIR}/live_runs"
mkdir -p "${LIVE_ROOT}/2099-12-31/live-demo"
LIVE_SUM="${LIVE_ROOT}/2099-12-31/live-demo/run_summary.jsonl"
cat >"${LIVE_SUM}" <<'EOF'
{"type":"WORKFLOW_START","workflow":"default","source":"/x.jh","ts":"2099-12-31T00:00:00Z","run_id":"live-run","event_version":1}
{"type":"STEP_START","func":"f","kind":"shell","name":"slow","ts":"2099-12-31T00:00:01Z","status":null,"elapsed_ms":null,"out_file":"","err_file":"","id":"live-step","parent_id":null,"seq":1,"depth":0,"run_id":"live-run","params":[],"event_version":1}
EOF

kill "${REPORT_PID}" >/dev/null 2>&1 || true
wait "${REPORT_PID}" 2>/dev/null || true
REPORT_PID=""

node "${ROOT_DIR}/dist/src/reporting/cli.js" --workspace "${TEST_DIR}" --port "${REPORT_PORT}" --host 127.0.0.1 --runs-dir "${LIVE_ROOT}" --poll-ms 150 &
REPORT_PID=$!

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${REPORT_PORT}/api/active" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

sleep 0.35
ACTIVE1="$(curl -fsS "http://127.0.0.1:${REPORT_PORT}/api/active")"
echo "${ACTIVE1}" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); if (!(j.runs&&j.runs.length===1)) process.exit(1);'

printf '%s\n' '{"type":"STEP_END","func":"f","kind":"shell","name":"slow","ts":"2099-12-31T00:00:02Z","status":0,"elapsed_ms":1,"out_file":"","err_file":"","id":"live-step","parent_id":null,"seq":1,"depth":0,"run_id":"live-run","params":[],"out_content":"done","event_version":1}' '{"type":"WORKFLOW_END","workflow":"default","source":"/x.jh","ts":"2099-12-31T00:00:03Z","run_id":"live-run","event_version":1}' >>"${LIVE_SUM}"

sleep 0.45
ACTIVE2="$(curl -fsS "http://127.0.0.1:${REPORT_PORT}/api/active")"
echo "${ACTIVE2}" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); if (j.runs&&j.runs.length) process.exit(1);'

e2e::pass "reporting server e2e"
