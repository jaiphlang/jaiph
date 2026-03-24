# Runtime: inbox dispatch for multi-agent workflows.
# Sourced by jaiph_stdlib.sh. Depends on steps.sh (run tracking) and events.sh.

# Max dispatch iterations before aborting (guards against infinite circular sends).
JAIPH_INBOX_MAX_DISPATCH_DEPTH="${JAIPH_INBOX_MAX_DISPATCH_DEPTH:-100}"

# Routes stored as newline-delimited "channel TAB targets" entries.
# Avoids bash 3.2 associative-array bugs (non-existent key returns last value).
JAIPH_ROUTES_LIST=""

# Initialise inbox state for the current run.
# Creates inbox directory and resets the sequence counter and dispatch queue.
jaiph::inbox_init() {
  if [[ -z "${JAIPH_RUN_DIR:-}" ]]; then
    jaiph::init_run_tracking
  fi
  export JAIPH_INBOX_DIR="${JAIPH_RUN_DIR}/inbox"
  mkdir -p "$JAIPH_INBOX_DIR"
  export JAIPH_INBOX_SEQ=0
  # File-based queue so entries survive subshell boundaries (run_step).
  export JAIPH_INBOX_QUEUE_FILE="${JAIPH_INBOX_DIR}/.queue"
  : > "$JAIPH_INBOX_QUEUE_FILE"
  JAIPH_ROUTES_LIST=""
}

# Send a message to a channel.
# Usage: jaiph::send <channel> <content> [<sender>]
# Writes content to NNN-<channel>.txt and appends to the file-based dispatch queue.
# <sender> is the workflow/function name that produced the message.
# When JAIPH_INBOX_PARALLEL=true, a file lock protects the sequence counter and
# queue append so concurrent senders cannot produce duplicate or skipped IDs.
jaiph::send() {
  local channel="$1"
  local content="$2"
  local sender="${3:-}"
  local _send_locked=0
  if [[ "${JAIPH_INBOX_PARALLEL:-}" == "true" ]]; then
    jaiph::_lock "${JAIPH_INBOX_DIR}/.seq.lock"
    _send_locked=1
  fi
  # Atomic sequence via a counter file so increments survive subshells.
  local seq_file="${JAIPH_INBOX_DIR}/.seq"
  local seq
  seq="$(cat "$seq_file" 2>/dev/null || echo 0)"
  seq=$(( seq + 1 ))
  printf '%s' "$seq" > "$seq_file"
  local seq_padded
  seq_padded=$(printf '%03d' "$seq")
  local msg_file="${JAIPH_INBOX_DIR}/${seq_padded}-${channel}.txt"
  printf '%s' "$content" > "$msg_file"
  printf '%s\n' "${channel}:${seq_padded}:${sender}" >> "$JAIPH_INBOX_QUEUE_FILE"
  jaiph::emit_inbox_enqueue_event "$channel" "$seq_padded" "$sender" "$content"
  if [[ "$_send_locked" -eq 1 ]]; then
    jaiph::_unlock "${JAIPH_INBOX_DIR}/.seq.lock"
  fi
}

# Register a routing rule: when a message arrives on <channel>, call the listed workflow functions.
# Usage: jaiph::register_route <channel> <func1> [<func2> ...]
jaiph::register_route() {
  local channel="$1"
  shift
  local new_targets="$*"
  local updated=""
  local found=0
  local IFS_save="$IFS"
  IFS=$'\n'
  local line
  for line in $JAIPH_ROUTES_LIST; do
    local key="${line%%	*}"
    if [[ "$key" == "$channel" ]]; then
      local existing="${line#*	}"
      updated="${updated}${channel}	${existing} ${new_targets}"$'\n'
      found=1
    else
      updated="${updated}${line}"$'\n'
    fi
  done
  IFS="$IFS_save"
  if [[ "$found" -eq 0 ]]; then
    updated="${updated}${channel}	${new_targets}"$'\n'
  fi
  JAIPH_ROUTES_LIST="$updated"
}

# Look up route targets for a channel. Sets _route_result (empty if none).
jaiph::_lookup_route() {
  local channel="$1"
  _route_result=""
  local IFS_save="$IFS"
  IFS=$'\n'
  local line
  for line in $JAIPH_ROUTES_LIST; do
    local key="${line%%	*}"
    if [[ "$key" == "$channel" ]]; then
      _route_result="${line#*	}"
      break
    fi
  done
  IFS="$IFS_save"
}

# JSON fragment: "payload_preview":"…","payload_ref":null|path (for INBOX_ENQUEUE).
jaiph::_inbox_enqueue_payload_json() {
  local content="$1"
  local path_rel="$2"
  local max=4096
  if [[ "${#content}" -le "$max" ]]; then
    printf '"payload_preview":"%s","payload_ref":null' "$(jaiph::json_escape "$content")"
    return 0
  fi
  local prev="${content:0:max}"
  printf '"payload_preview":"%s...","payload_ref":"%s"' \
    "$(jaiph::json_escape "$prev")" \
    "$(jaiph::json_escape "$path_rel")"
}

jaiph::emit_inbox_enqueue_event() {
  local channel="$1"
  local seq_padded="$2"
  local sender="$3"
  local content="$4"
  if [[ -z "${JAIPH_RUN_SUMMARY_FILE:-}" ]]; then
    return 0
  fi
  local ts path_rel pf line
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  path_rel="inbox/${seq_padded}-${channel}.txt"
  pf="$(jaiph::_inbox_enqueue_payload_json "$content" "$path_rel")"
  line="$(printf '{"type":"INBOX_ENQUEUE","inbox_seq":"%s","channel":"%s","sender":"%s",%s,"ts":"%s","run_id":"%s","event_version":1}' \
    "$(jaiph::json_escape "$seq_padded")" \
    "$(jaiph::json_escape "$channel")" \
    "$(jaiph::json_escape "$sender")" \
    "$pf" \
    "$(jaiph::json_escape "$ts")" \
    "$(jaiph::json_escape "${JAIPH_RUN_ID:-}")")"
  jaiph::_run_summary_append_line "$line"
}

jaiph::emit_inbox_dispatch_start() {
  local seq_padded="$1"
  local channel="$2"
  local target="$3"
  local sender="$4"
  if [[ -z "${JAIPH_RUN_SUMMARY_FILE:-}" ]]; then
    return 0
  fi
  local ts line
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  line="$(printf '{"type":"INBOX_DISPATCH_START","inbox_seq":"%s","channel":"%s","target":"%s","sender":"%s","ts":"%s","run_id":"%s","event_version":1}' \
    "$(jaiph::json_escape "$seq_padded")" \
    "$(jaiph::json_escape "$channel")" \
    "$(jaiph::json_escape "$target")" \
    "$(jaiph::json_escape "$sender")" \
    "$(jaiph::json_escape "$ts")" \
    "$(jaiph::json_escape "${JAIPH_RUN_ID:-}")")"
  jaiph::_run_summary_append_line "$line"
}

jaiph::emit_inbox_dispatch_complete() {
  local seq_padded="$1"
  local channel="$2"
  local target="$3"
  local sender="$4"
  local status="$5"
  local elapsed_ms="$6"
  if [[ -z "${JAIPH_RUN_SUMMARY_FILE:-}" ]]; then
    return 0
  fi
  local ts line
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  line="$(printf '{"type":"INBOX_DISPATCH_COMPLETE","inbox_seq":"%s","channel":"%s","target":"%s","sender":"%s","status":%s,"elapsed_ms":%s,"ts":"%s","run_id":"%s","event_version":1}' \
    "$(jaiph::json_escape "$seq_padded")" \
    "$(jaiph::json_escape "$channel")" \
    "$(jaiph::json_escape "$target")" \
    "$(jaiph::json_escape "$sender")" \
    "${status:-0}" \
    "${elapsed_ms:-0}" \
    "$(jaiph::json_escape "$ts")" \
    "$(jaiph::json_escape "${JAIPH_RUN_ID:-}")")"
  jaiph::_run_summary_append_line "$line"
}

# Run one routed inbox target; emits dispatch start/complete around the call.
jaiph::_inbox_run_dispatch_target() {
  local seq_padded="$1"
  local channel="$2"
  local target="$3"
  local sender="$4"
  local content="$5"
  jaiph::emit_inbox_dispatch_start "$seq_padded" "$channel" "$target" "$sender"
  local _t0="$SECONDS"
  JAIPH_DISPATCH_CHANNEL="$channel" JAIPH_DISPATCH_SENDER="$sender" "$target" "$content" "$channel" "$sender"
  local _st=$?
  local _elapsed=$(( (SECONDS - _t0) * 1000 ))
  jaiph::emit_inbox_dispatch_complete "$seq_padded" "$channel" "$target" "$sender" "$_st" "$_elapsed"
  return "$_st"
}

# Drain the dispatch queue: process messages until empty or depth limit reached.
# Each dispatched workflow may call jaiph::send, growing the queue further.
#
# When JAIPH_INBOX_PARALLEL=true, all route targets for a batch of queue entries
# are launched as background jobs and awaited together before the next batch.
# Ordering among parallel targets is intentionally non-deterministic; only the
# queue-entry order (FIFO) is preserved between batches.  Any failed target
# causes the owning workflow to fail after all siblings in the batch complete.
jaiph::drain_queue() {
  local depth=0
  local cursor=0
  local parallel="${JAIPH_INBOX_PARALLEL:-false}"
  while true; do
    local queue_lines
    queue_lines="$(tail -n +$(( cursor + 1 )) "$JAIPH_INBOX_QUEUE_FILE" 2>/dev/null)" || true
    [[ -n "$queue_lines" ]] || break
    if [[ "$parallel" == "true" ]]; then
      # --- parallel dispatch ---
      local pids=()
      local entry
      while IFS= read -r entry; do
        [[ -n "$entry" ]] || continue
        depth=$(( depth + 1 ))
        cursor=$(( cursor + 1 ))
        if [[ $depth -gt $JAIPH_INBOX_MAX_DISPATCH_DEPTH ]]; then
          echo "jaiph: E_DISPATCH_DEPTH — dispatch loop exceeded ${JAIPH_INBOX_MAX_DISPATCH_DEPTH} iterations (possible circular sends)" >&2
          wait 2>/dev/null || true
          exit 1
        fi
        local channel="${entry%%:*}"
        local rest="${entry#*:}"
        local seq_padded="${rest%%:*}"
        local sender="${rest#*:}"
        if [[ "$sender" == "$seq_padded" ]]; then sender=""; fi
        jaiph::_lookup_route "$channel"
        if [[ -z "$_route_result" ]]; then
          continue
        fi
        local msg_file="${JAIPH_INBOX_DIR}/${seq_padded}-${channel}.txt"
        local content
        content="$(cat "$msg_file")"
        local target
        for target in $_route_result; do
          jaiph::_inbox_run_dispatch_target "$seq_padded" "$channel" "$target" "$sender" "$content" &
          pids+=($!)
        done
      done <<< "$queue_lines"
      # Wait for all parallel targets; propagate first failure.
      local any_fail=0
      local pid
      for pid in "${pids[@]}"; do
        if ! wait "$pid"; then
          any_fail=1
        fi
      done
      if [[ "$any_fail" -eq 1 ]]; then
        exit 1
      fi
    else
      # --- sequential dispatch (default) ---
      local entry
      while IFS= read -r entry; do
        [[ -n "$entry" ]] || continue
        depth=$(( depth + 1 ))
        cursor=$(( cursor + 1 ))
        if [[ $depth -gt $JAIPH_INBOX_MAX_DISPATCH_DEPTH ]]; then
          echo "jaiph: E_DISPATCH_DEPTH — dispatch loop exceeded ${JAIPH_INBOX_MAX_DISPATCH_DEPTH} iterations (possible circular sends)" >&2
          exit 1
        fi
        local channel="${entry%%:*}"
        local rest="${entry#*:}"
        local seq_padded="${rest%%:*}"
        local sender="${rest#*:}"
        # Entries written before sender tracking have no second colon; treat as empty.
        if [[ "$sender" == "$seq_padded" ]]; then sender=""; fi
        jaiph::_lookup_route "$channel"
        if [[ -z "$_route_result" ]]; then
          # No route registered for this channel — silent drop.
          continue
        fi
        local msg_file="${JAIPH_INBOX_DIR}/${seq_padded}-${channel}.txt"
        local content
        content="$(cat "$msg_file")"
        local target
        for target in $_route_result; do
          jaiph::_inbox_run_dispatch_target "$seq_padded" "$channel" "$target" "$sender" "$content"
        done
      done <<< "$queue_lines"
    fi
  done
}
