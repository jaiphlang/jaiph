#!/usr/bin/env bash
#
# Artifacts helper for Jaiph workflows.
# Reads JAIPH_ARTIFACTS_DIR to locate the writable artifacts directory.
# Works identically inside the Docker sandbox and on the host.
#
set -euo pipefail

ARTIFACTS_DIR="${JAIPH_ARTIFACTS_DIR:?JAIPH_ARTIFACTS_DIR is not set}"

cmd_save() {
  local src="$1" name="$2"
  if [[ ! -f "${src}" ]]; then
    printf 'artifacts save: file not found: %s\n' "${src}" >&2
    exit 1
  fi
  local dest="${ARTIFACTS_DIR}/${name}"
  mkdir -p "$(dirname "${dest}")"
  cp -- "${src}" "${dest}"
  printf '%s' "${dest}"
}

cmd_save_patch() {
  local name="$1"
  local dest="${ARTIFACTS_DIR}/${name}"
  mkdir -p "$(dirname "${dest}")"
  # Exclude .jaiph/ from the produced patch — the runtime writes its own
  # state under .jaiph/ and including it would clobber state on apply.
  local diff_out
  diff_out="$(git diff HEAD -- . ':!.jaiph/' 2>/dev/null || true)"
  if [[ -z "${diff_out}" ]]; then
    # Also check for untracked files (intent-to-add)
    git add -N . -- ':!.jaiph/' 2>/dev/null || true
    diff_out="$(git diff HEAD -- . ':!.jaiph/' 2>/dev/null || true)"
    # Reset intent-to-add to avoid side effects
    git reset HEAD -- . 2>/dev/null || true
  fi
  if [[ -n "${diff_out}" ]]; then
    printf '%s\n' "${diff_out}" > "${dest}"
  else
    # Empty/clean workspace — create empty file
    : > "${dest}"
  fi
  printf '%s' "${dest}"
}

cmd_apply_patch() {
  local patch_path="$1"
  if [[ ! -f "${patch_path}" ]]; then
    printf 'artifacts apply_patch: patch file not found: %s\n' "${patch_path}" >&2
    exit 1
  fi
  if [[ ! -s "${patch_path}" ]]; then
    printf 'artifacts apply_patch: patch file is empty: %s\n' "${patch_path}" >&2
    exit 1
  fi
  git apply "${patch_path}"
}

# -- dispatch ----------------------------------------------------------------
cmd="${1:-}"
shift || true

case "${cmd}" in
  save)         cmd_save "$@" ;;
  save_patch)   cmd_save_patch "$@" ;;
  apply_patch)  cmd_apply_patch "$@" ;;
  *)
    printf 'Usage: artifacts <save|save_patch|apply_patch> [args...]\n' >&2
    exit 1
    ;;
esac
