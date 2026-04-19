#!/usr/bin/env bash
set -euo pipefail

# Backing script for workspace stdlib (workspace.jh).
# Commands: export_patch, export, apply_patch.
#
# Environment:
#   JAIPH_WORKSPACE  — workspace root (cwd fallback)
#   JAIPH_RUN_DIR    — current run artifact directory

CMD="${1:-}"
shift || true

WORKSPACE="${JAIPH_WORKSPACE:-.}"

case "$CMD" in
  export_patch)
    # Usage: export_patch <name>
    # Produces a git diff (excluding .jaiph/) and writes it to JAIPH_RUN_DIR/<name>.
    # .jaiph/ is excluded because both the branch and the coordinator write run
    # artifacts there; including those in the patch would clobber state on apply.
    NAME="${1:?export_patch requires a name argument}"
    OUT="${JAIPH_RUN_DIR:?JAIPH_RUN_DIR must be set}/${NAME}"

    cd "$WORKSPACE"

    # Stage intent-to-add for untracked files so they appear in git diff
    git add -N . 2>/dev/null || true

    # Generate diff excluding .jaiph/ directory (:(exclude) pathspec syntax)
    diff_content="$(git diff -- . ':(exclude).jaiph' 2>/dev/null || true)"

    if [ -z "$diff_content" ]; then
      printf '' > "$OUT"
    else
      printf '%s\n' "$diff_content" > "$OUT"
    fi

    printf '%s' "$OUT"
    ;;

  export)
    # Usage: export <local_path> <name>
    # Copies a file from local_path inside the workspace to JAIPH_RUN_DIR/<name>.
    LOCAL_PATH="${1:?export requires a local_path argument}"
    NAME="${2:?export requires a name argument}"
    OUT="${JAIPH_RUN_DIR:?JAIPH_RUN_DIR must be set}/${NAME}"

    # Resolve relative paths against workspace
    if [[ "$LOCAL_PATH" != /* ]]; then
      LOCAL_PATH="${WORKSPACE}/${LOCAL_PATH}"
    fi

    if [ ! -f "$LOCAL_PATH" ]; then
      printf 'export: file not found: %s\n' "$LOCAL_PATH" >&2
      exit 1
    fi

    cp "$LOCAL_PATH" "$OUT"
    printf '%s' "$OUT"
    ;;

  apply_patch)
    # Usage: apply_patch <path>
    # Applies a patch file to the workspace via git apply.
    PATCH_PATH="${1:?apply_patch requires a path argument}"

    if [ ! -f "$PATCH_PATH" ]; then
      printf 'apply_patch: patch file not found: %s\n' "$PATCH_PATH" >&2
      exit 1
    fi

    # Empty patch is a no-op
    if [ ! -s "$PATCH_PATH" ]; then
      exit 0
    fi

    cd "$WORKSPACE"
    git apply "$PATCH_PATH"
    ;;

  *)
    printf 'workspace: unknown command: %s\n' "$CMD" >&2
    exit 1
    ;;
esac
