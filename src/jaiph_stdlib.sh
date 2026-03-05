#!/usr/bin/env bash
# Standard helpers shared by transpiled Jaiph modules.
# Thin aggregator: core API + sourced runtime submodules.

jaiph__version() {
  echo "jaiph 0.2.0"
}

jaiph__runtime_api() {
  echo "1"
}

jaiph__die() {
  local message="$1"
  echo "jai: $message" >&2
  return 1
}

jaiph__expect_contain() {
  local haystack="$1"
  local needle="$2"
  if [[ -z "$needle" ]]; then
    return 0
  fi
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "jai: expectContain failed: expected to find:" >&2
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
# shellcheck source=src/runtime/prompt.sh
source "${_jaiph_runtime_dir}/runtime/prompt.sh"
# shellcheck source=src/runtime/sandbox.sh
source "${_jaiph_runtime_dir}/runtime/sandbox.sh"
unset _jaiph_runtime_dir
