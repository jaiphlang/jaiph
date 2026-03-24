#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "run_summary_event_contract"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"
unset JAIPH_STDLIB

e2e::section "run_summary.jsonl contract under parallel inbox dispatch"

e2e::file "summary_contract.jh" <<'EOF'
config {
  run.inbox_parallel = true
}

channel ch

workflow sender {
  log "contract-sender-log"
  logerr "contract-sender-err"
  ch <- echo "contract-payload"
}

workflow receiver_a {
  echo "a:$1" > contract_a.txt
}

workflow receiver_b {
  echo "b:$1" > contract_b.txt
}

workflow default {
  log "contract-root-log"
  logerr "contract-root-err"
  run sender
  ch -> receiver_a, receiver_b
}
EOF

e2e::run "summary_contract.jh" >/dev/null

e2e::assert_file_exists "${TEST_DIR}/contract_a.txt" "receiver_a ran"
e2e::assert_file_exists "${TEST_DIR}/contract_b.txt" "receiver_b ran"

run_dir="$(e2e::run_dir "summary_contract.jh")"
summary="${run_dir}/run_summary.jsonl"
e2e::assert_file_exists "$summary" "run_summary.jsonl exists"

if ! command -v python3 >/dev/null 2>&1; then
  e2e::fail "python3 required for run_summary contract assertions"
fi

python3 - "$summary" <<'PY'
import json, sys

path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines()
events = []
for i, line in enumerate(lines, 1):
    if not line.strip():
        continue
    try:
        events.append(json.loads(line))
    except json.JSONDecodeError as e:
        sys.exit(f"line {i}: invalid JSON: {e}")

run_ids = {e.get("run_id") for e in events if e.get("run_id")}
if len(run_ids) != 1:
    sys.exit(f"expected exactly one run_id, got {run_ids!r}")
rid = next(iter(run_ids))

for i, e in enumerate(events):
    for k in ("type", "ts", "run_id", "event_version"):
        if k not in e:
            sys.exit(f"event {i} ({e.get('type')}) missing required key {k!r}")
    if e["run_id"] != rid:
        sys.exit("run_id mismatch across events")
    if e["event_version"] != 1:
        sys.exit(f"event {i}: event_version must be 1")

need_log = ("contract-root-log", "contract-sender-log")
need_err = ("contract-root-err", "contract-sender-err")
log_msgs = [e["message"] for e in events if e.get("type") == "LOG"]
err_msgs = [e["message"] for e in events if e.get("type") == "LOGERR"]
for n in need_log:
    if not any(n in m for m in log_msgs):
        sys.exit(f"missing LOG containing {n!r}")
for n in need_err:
    if not any(n in m for m in err_msgs):
        sys.exit(f"missing LOGERR containing {n!r}")

starts = {}
ends = {}
for e in events:
    ty = e.get("type")
    if ty == "WORKFLOW_START":
        name = e.get("workflow")
        if not name:
            sys.exit("WORKFLOW_START missing workflow")
        starts[name] = starts.get(name, 0) + 1
    elif ty == "WORKFLOW_END":
        name = e.get("workflow")
        if not name:
            sys.exit("WORKFLOW_END missing workflow")
        ends[name] = ends.get(name, 0) + 1
for name in set(starts) | set(ends):
    if starts.get(name, 0) != ends.get(name, 0):
        sys.exit(f"workflow {name!r}: WORKFLOW_START count != WORKFLOW_END count")

by_step_id = {}
for idx, e in enumerate(events):
    t = e.get("type")
    if t == "STEP_START":
        sid = e.get("id")
        if not sid:
            sys.exit("STEP_START without id")
        if sid in by_step_id:
            sys.exit(f"duplicate STEP_START for id {sid!r}")
        by_step_id[sid] = {"start": idx, "end": None}
    elif t == "STEP_END":
        sid = e.get("id")
        if sid not in by_step_id:
            sys.exit(f"STEP_END without STEP_START for id {sid!r}")
        if by_step_id[sid]["end"] is not None:
            sys.exit(f"duplicate STEP_END for id {sid!r}")
        by_step_id[sid]["end"] = idx
for sid, z in by_step_id.items():
    if z["end"] is None:
        sys.exit(f"missing STEP_END for id {sid!r}")
    if z["start"] >= z["end"]:
        sys.exit(f"STEP_START must precede STEP_END for id {sid!r}")

enqueue_at = {}
for i, e in enumerate(events):
    if e.get("type") == "INBOX_ENQUEUE":
        seq = e.get("inbox_seq")
        if not seq:
            sys.exit("INBOX_ENQUEUE missing inbox_seq")
        if seq in enqueue_at:
            sys.exit("duplicate INBOX_ENQUEUE for same inbox_seq")
        enqueue_at[seq] = i

if not enqueue_at:
    sys.exit("expected at least one INBOX_ENQUEUE")
enq_events = [e for e in events if e.get("type") == "INBOX_ENQUEUE"]
if len(enq_events) != 1:
    sys.exit(f"expected exactly one INBOX_ENQUEUE, got {len(enq_events)}")
_e0 = enq_events[0]
if _e0.get("channel") != "ch":
    sys.exit("INBOX_ENQUEUE.channel mismatch")
if "contract-payload" not in str(_e0.get("payload_preview", "")):
    sys.exit("INBOX_ENQUEUE.payload_preview missing sent body")
if _e0.get("payload_ref") is not None:
    sys.exit("expected payload_ref null for small payload")

open_dispatch = {}
for i, e in enumerate(events):
    t = e.get("type")
    if t == "INBOX_DISPATCH_START":
        key = (e.get("inbox_seq"), e.get("channel"), e.get("target"), e.get("sender"))
        if any(x is None for x in key):
            sys.exit("INBOX_DISPATCH_START missing correlation field")
        seq = key[0]
        if seq not in enqueue_at:
            sys.exit("INBOX_DISPATCH_START for unknown inbox_seq")
        if i < enqueue_at[seq]:
            sys.exit("INBOX_DISPATCH_START before INBOX_ENQUEUE for same seq")
        if key in open_dispatch:
            sys.exit("duplicate INBOX_DISPATCH_START for same dispatch key")
        open_dispatch[key] = i
    elif t == "INBOX_DISPATCH_COMPLETE":
        key = (e.get("inbox_seq"), e.get("channel"), e.get("target"), e.get("sender"))
        if key not in open_dispatch:
            sys.exit("INBOX_DISPATCH_COMPLETE without matching START")
        si = open_dispatch.pop(key)
        if si >= i:
            sys.exit("INBOX_DISPATCH_START must precede COMPLETE")
        seq = key[0]
        if i < enqueue_at[seq]:
            sys.exit("INBOX_DISPATCH_COMPLETE before INBOX_ENQUEUE")
        if not isinstance(e.get("status"), int) or not isinstance(e.get("elapsed_ms"), int):
            sys.exit("INBOX_DISPATCH_COMPLETE requires int status and elapsed_ms")

if open_dispatch:
    sys.exit("unclosed INBOX_DISPATCH_START")

want_types = (
    "WORKFLOW_START",
    "WORKFLOW_END",
    "STEP_START",
    "STEP_END",
    "LOG",
    "LOGERR",
    "INBOX_ENQUEUE",
    "INBOX_DISPATCH_START",
    "INBOX_DISPATCH_COMPLETE",
)
seen = {e.get("type") for e in events}
for wt in want_types:
    if wt not in seen:
        sys.exit(f"missing event type {wt!r} in run_summary.jsonl")
PY

e2e::pass "run_summary.jsonl: LOG/LOGERR persistence, inbox lifecycle, step pairing, workflow balance, JSONL validity (parallel)"
