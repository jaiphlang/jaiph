#!/usr/bin/env bash
# Standard helpers shared by transpiled Jaiph modules.
# Thin aggregator: core API + sourced runtime submodules.

jaiph__version() {
  echo "jaiph 0.5.0"
}

jaiph__runtime_api() {
  echo "1"
}

jaiph__die() {
  local message="$1"
  echo "jaiph: $message" >&2
  return 1
}

# Portable file-lock primitives using mkdir (atomic on all POSIX systems).
# Used by inbox parallel dispatch to protect shared state files.
jaiph::_lock() {
  local lockdir="$1"
  local timeout_s="${JAIPH_LOCK_TIMEOUT_SECONDS:-30}"
  local sleep_s="${JAIPH_LOCK_SLEEP_SECONDS:-0.05}"
  case "$timeout_s" in
    ''|*[!0-9]*) timeout_s=30 ;;
  esac
  if [[ -z "$sleep_s" ]]; then
    sleep_s="0.05"
  fi
  local started_at="$SECONDS"
  while ! mkdir "$lockdir" 2>/dev/null; do
    # If owner pid is known and no longer alive, clear stale lock.
    if [[ -f "${lockdir}/pid" ]]; then
      local owner_pid
      owner_pid="$(<"${lockdir}/pid")"
      if [[ -n "$owner_pid" ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
        rm -f "${lockdir}/pid" 2>/dev/null || true
        rmdir "$lockdir" 2>/dev/null || true
        continue
      fi
    fi
    if (( SECONDS - started_at >= timeout_s )); then
      echo "jaiph: lock timeout while waiting for ${lockdir}" >&2
      return 1
    fi
    sleep "$sleep_s"
  done
  printf '%s\n' "$$" > "${lockdir}/pid" 2>/dev/null || true
  return 0
}

jaiph::_unlock() {
  local lockdir="$1"
  rm -f "${lockdir}/pid" 2>/dev/null || true
  rmdir "$lockdir" 2>/dev/null || true
}

jaiph__expect_contain() {
  local haystack="$1"
  local needle="$2"
  if [[ -z "$needle" ]]; then
    return 0
  fi
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "jaiph: expectContain failed: expected to find:" >&2
    echo "---" >&2
    printf '%s\n' "$needle" >&2
    echo "---" >&2
    echo "in output (${#haystack} chars):" >&2
    echo "---" >&2
    printf '%s\n' "$haystack" | head -100 >&2
    echo "---" >&2
    return 1
  fi
  return 0
}

jaiph__expect_not_contain() {
  local haystack="$1"
  local needle="$2"
  if [[ -z "$needle" ]]; then
    return 0
  fi
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "jaiph: expectNotContain failed: did not expect to find:" >&2
    echo "---" >&2
    printf '%s\n' "$needle" >&2
    echo "---" >&2
    echo "in output (${#haystack} chars):" >&2
    echo "---" >&2
    printf '%s\n' "$haystack" | head -100 >&2
    echo "---" >&2
    return 1
  fi
  return 0
}

jaiph__expect_equal() {
  local actual="$1"
  local expected="$2"
  if [[ "$actual" != "$expected" ]]; then
    local gray=$'\e[90m'
    local red=$'\e[31m'
    local reset=$'\e[0m'
    echo "expectEqual failed:" >&2
    printf '%b- %s%b\n' "$gray" "$expected" "$reset" >&2
    printf '%b+ %s%b\n' "$red" "$actual" "$reset" >&2
    return 1
  fi
  return 0
}

# Source runtime submodules (order matters: events → test-mode → steps → prompt → sandbox).
_jaiph_runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=src/runtime/events.sh
source "${_jaiph_runtime_dir}/runtime/events.sh"
# shellcheck source=src/runtime/test-mode.sh
source "${_jaiph_runtime_dir}/runtime/test-mode.sh"
# shellcheck source=src/runtime/steps.sh
source "${_jaiph_runtime_dir}/runtime/steps.sh"
# shellcheck source=src/runtime/inbox.sh
source "${_jaiph_runtime_dir}/runtime/inbox.sh"
# shellcheck source=src/runtime/prompt.sh
source "${_jaiph_runtime_dir}/runtime/prompt.sh"
# shellcheck source=src/runtime/sandbox.sh
source "${_jaiph_runtime_dir}/runtime/sandbox.sh"

# Backwards-compatible top-level aliases for DSL convenience.
# Some compiled scripts may call `log`/`logerr` directly.
log() {
  jaiph::log "$@"
}

logerr() {
  jaiph::logerr "$@"
}

unset _jaiph_runtime_dir
