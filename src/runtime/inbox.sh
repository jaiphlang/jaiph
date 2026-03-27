# Runtime: inbox dispatch for multi-agent workflows (file-backed transport via kernel/inbox.js).
# Sourced by jaiph_stdlib.sh. Depends on steps.sh (run tracking) and events.sh (JAIPH_EMIT_JS).

# Resolve kernel/inbox.js: same rules as JAIPH_EMIT_JS in events.sh.
_jaiph_inbox_kernel_dir=""
if [[ -n "${JAIPH_STDLIB:-}" ]]; then
  _inbox_js_candidate="$(cd "$(dirname "$JAIPH_STDLIB")" && pwd)/runtime/kernel/inbox.js"
  if [[ -f "$_inbox_js_candidate" ]]; then
    _jaiph_inbox_kernel_dir="$(cd "$(dirname "$_inbox_js_candidate")" && pwd)"
  fi
fi
if [[ -z "${_jaiph_inbox_kernel_dir:-}" ]]; then
  _jaiph_inbox_kernel_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kernel"
fi
unset _inbox_js_candidate
export JAIPH_INBOX_JS="${_jaiph_inbox_kernel_dir}/inbox.js"

# Max dispatch iterations before aborting (guards against infinite circular sends).
JAIPH_INBOX_MAX_DISPATCH_DEPTH="${JAIPH_INBOX_MAX_DISPATCH_DEPTH:-100}"

# Initialise inbox state for the current run.
jaiph::inbox_init() {
  if [[ -z "${JAIPH_RUN_DIR:-}" ]]; then
    jaiph::init_run_tracking
  fi
  export JAIPH_INBOX_DIR="${JAIPH_RUN_DIR}/inbox"
  node "${JAIPH_INBOX_JS}" init || return $?
}

# Send a message to a channel.
# Usage: jaiph::send <channel> <content> [<sender>]
jaiph::send() {
  node "${JAIPH_INBOX_JS}" send "$1" "$2" "${3:-}" || return 1
}

# Register a routing rule: when a message arrives on <channel>, call the listed workflow functions.
# Usage: jaiph::register_route <channel> <func1> [<func2> ...]
jaiph::register_route() {
  local channel="$1"
  shift
  node "${JAIPH_INBOX_JS}" register-route "$channel" "$@" || return $?
}

# Drain the dispatch queue (see kernel/inbox.ts).
jaiph::drain_queue() {
  node "${JAIPH_INBOX_JS}" drain || return $?
}
