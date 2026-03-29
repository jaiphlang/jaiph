#!/usr/bin/env bash
#
# run_summary.jsonl canonical event contract
# ==========================================
# Every run produces a JSONL file where each line is a JSON object with at
# minimum: type, ts, run_id, event_version (always 1).
#
# Required event types for a workflow with inbox dispatch:
#   WORKFLOW_START    — workflow={name}
#   WORKFLOW_END      — workflow={name}
#   STEP_START        — id={unique-step-id}
#   STEP_END          — id={matching-step-id}
#   LOG               — message={string}
#   INBOX_ENQUEUE     — channel, inbox_seq
#   INBOX_DISPATCH_START    — channel, target, inbox_seq, sender
#   INBOX_DISPATCH_COMPLETE — channel, target, inbox_seq, sender, status, elapsed_ms
#
# Invariants:
#   - Single run_id across all events
#   - WORKFLOW_START/END counts balance per workflow name
#   - STEP_START precedes its matching STEP_END (by id)
#   - Every INBOX_DISPATCH_START has a matching INBOX_DISPATCH_COMPLETE
#     for the same (channel, target, inbox_seq), and START precedes COMPLETE
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "run_summary_event_contract"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "run_summary.jsonl contract under parallel inbox dispatch"

e2e::file "summary_contract.jh" <<'EOF'
config {
  run.inbox_parallel = true
}

channel ch

script emit_payload() {
  echo "contract-payload"
}

workflow sender() {
  log "contract-sender-log"
  ch <- run emit_payload
}

script write_a() {
  echo "a:$1" > contract_a.txt
}
workflow receiver_a() {
  run write_a "${arg1}"
}

script write_b() {
  echo "b:$1" > contract_b.txt
}
workflow receiver_b() {
  run write_b "${arg1}"
}

workflow default() {
  log "contract-root-log"
  run sender
  ch -> receiver_a, receiver_b
}
EOF

e2e::run "summary_contract.jh" >/dev/null

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
log_msgs = [e["message"] for e in events if e.get("type") == "LOG"]
for n in need_log:
    if not any(n in m for m in log_msgs):
        sys.exit(f"missing LOG containing {n!r}")

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

dispatch_starts = {}
dispatch_ends = {}
for idx, e in enumerate(events):
    t = e.get("type")
    if t == "INBOX_DISPATCH_START":
        for fld in ("channel", "target", "inbox_seq", "sender"):
            if not e.get(fld):
                sys.exit(f"INBOX_DISPATCH_START event {idx} missing required field {fld!r}")
        key = (e["channel"], e["target"], e["inbox_seq"])
        if key in dispatch_starts:
            sys.exit(f"duplicate INBOX_DISPATCH_START for {key!r}")
        dispatch_starts[key] = idx
    elif t == "INBOX_DISPATCH_COMPLETE":
        for fld in ("channel", "target", "inbox_seq", "sender", "status", "elapsed_ms"):
            if fld not in e:
                sys.exit(f"INBOX_DISPATCH_COMPLETE event {idx} missing required field {fld!r}")
        key = (e["channel"], e["target"], e["inbox_seq"])
        if key in dispatch_ends:
            sys.exit(f"duplicate INBOX_DISPATCH_COMPLETE for {key!r}")
        dispatch_ends[key] = idx

if not dispatch_starts:
    sys.exit("expected at least one INBOX_DISPATCH_START")

for key in set(dispatch_starts) | set(dispatch_ends):
    if key not in dispatch_starts:
        sys.exit(f"INBOX_DISPATCH_COMPLETE without INBOX_DISPATCH_START for {key!r}")
    if key not in dispatch_ends:
        sys.exit(f"INBOX_DISPATCH_START without INBOX_DISPATCH_COMPLETE for {key!r}")
    if dispatch_starts[key] >= dispatch_ends[key]:
        sys.exit(f"INBOX_DISPATCH_START must precede INBOX_DISPATCH_COMPLETE for {key!r}")

want_types = (
    "WORKFLOW_START",
    "WORKFLOW_END",
    "STEP_START",
    "STEP_END",
    "LOG",
    "INBOX_ENQUEUE",
    "INBOX_DISPATCH_START",
    "INBOX_DISPATCH_COMPLETE",
)
seen = {e.get("type") for e in events}
for wt in want_types:
    if wt not in seen:
        sys.exit(f"missing event type {wt!r} in run_summary.jsonl")
PY

e2e::pass "run_summary.jsonl: LOG persistence, enqueue event, dispatch pairing, step pairing, workflow balance, JSONL validity (parallel)"
