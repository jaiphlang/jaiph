# Runtime: inbox dispatch for multi-agent workflows.
# Sourced by jaiph_stdlib.sh. Depends on steps.sh (run tracking) and events.sh.

# Max dispatch iterations before aborting (guards against infinite circular sends).
JAIPH_INBOX_MAX_DISPATCH_DEPTH="${JAIPH_INBOX_MAX_DISPATCH_DEPTH:-100}"

# Initialise inbox state for the current run.
# Creates inbox directory and resets the sequence counter and dispatch queue.
jaiph::inbox_init() {
  if [[ -z "${JAIPH_RUN_DIR:-}" ]]; then
    jaiph::init_run_tracking
  fi
  export JAIPH_INBOX_DIR="${JAIPH_RUN_DIR}/inbox"
  mkdir -p "$JAIPH_INBOX_DIR"
  export JAIPH_INBOX_SEQ=0
  JAIPH_DISPATCH_QUEUE=()
  declare -gA JAIPH_ROUTES 2>/dev/null || true
}

# Send a message to a channel.
# Usage: jaiph::send <channel> <content>
# Writes content to NNN-<channel>.txt and appends to the dispatch queue.
jaiph::send() {
  local channel="$1"
  local content="$2"
  JAIPH_INBOX_SEQ=$(( JAIPH_INBOX_SEQ + 1 ))
  local seq_padded
  seq_padded=$(printf '%03d' "$JAIPH_INBOX_SEQ")
  local msg_file="${JAIPH_INBOX_DIR}/${seq_padded}-${channel}.txt"
  printf '%s' "$content" > "$msg_file"
  JAIPH_DISPATCH_QUEUE+=("${channel}:${seq_padded}")
}

# Register a routing rule: when a message arrives on <channel>, call the listed workflow functions.
# Usage: jaiph::register_route <channel> <func1> [<func2> ...]
jaiph::register_route() {
  local channel="$1"
  shift
  local existing="${JAIPH_ROUTES[$channel]:-}"
  if [[ -n "$existing" ]]; then
    JAIPH_ROUTES[$channel]="$existing $*"
  else
    JAIPH_ROUTES[$channel]="$*"
  fi
}

# Drain the dispatch queue: process messages sequentially until empty or depth limit reached.
# Each dispatched workflow may call jaiph::send, growing the queue further.
jaiph::drain_queue() {
  local depth=0
  while [[ ${#JAIPH_DISPATCH_QUEUE[@]} -gt 0 ]]; do
    depth=$(( depth + 1 ))
    if [[ $depth -gt $JAIPH_INBOX_MAX_DISPATCH_DEPTH ]]; then
      echo "jaiph: E_DISPATCH_DEPTH — dispatch loop exceeded ${JAIPH_INBOX_MAX_DISPATCH_DEPTH} iterations (possible circular sends)" >&2
      exit 1
    fi
    local entry="${JAIPH_DISPATCH_QUEUE[0]}"
    JAIPH_DISPATCH_QUEUE=("${JAIPH_DISPATCH_QUEUE[@]:1}")
    local channel="${entry%%:*}"
    local seq_padded="${entry#*:}"
    local route_targets="${JAIPH_ROUTES[$channel]:-}"
    if [[ -z "$route_targets" ]]; then
      # No route registered for this channel — silent drop.
      continue
    fi
    local msg_file="${JAIPH_INBOX_DIR}/${seq_padded}-${channel}.txt"
    local content
    content="$(cat "$msg_file")"
    local target
    for target in $route_targets; do
      JAIPH_DISPATCH_CHANNEL="$channel" "$target" "$content"
    done
  done
}
