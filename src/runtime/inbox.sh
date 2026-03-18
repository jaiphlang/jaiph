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
# Usage: jaiph::send <channel> <content>
# Writes content to NNN-<channel>.txt and appends to the file-based dispatch queue.
jaiph::send() {
  local channel="$1"
  local content="$2"
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
  printf '%s\n' "${channel}:${seq_padded}" >> "$JAIPH_INBOX_QUEUE_FILE"
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

# Drain the dispatch queue: process messages sequentially until empty or depth limit reached.
# Each dispatched workflow may call jaiph::send, growing the queue further.
jaiph::drain_queue() {
  local depth=0
  local cursor=0
  while true; do
    local queue_lines
    queue_lines="$(tail -n +$(( cursor + 1 )) "$JAIPH_INBOX_QUEUE_FILE" 2>/dev/null)" || true
    [[ -n "$queue_lines" ]] || break
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
      local seq_padded="${entry#*:}"
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
        JAIPH_DISPATCH_CHANNEL="$channel" "$target" "$content"
      done
    done <<< "$queue_lines"
  done
}
