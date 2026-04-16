#!/usr/bin/env bash
# Jaiph Docker sandbox: CoW workspace overlay with delta extraction.
#
# Mounts a fuse-overlayfs on top of the read-only workspace mount so
# workflows can read all files while writes land in a tmpfs upper layer.
# Falls back to a full copy when FUSE is unavailable (no --cap-add SYS_ADMIN).
#
# After the inner command exits, only changed/added files and a deletion
# manifest are written to /jaiph/delta/ for the host CLI to apply.
set -euo pipefail

LOWER=/jaiph/workspace-ro
UPPER=/tmp/overlay-upper
WORK=/tmp/overlay-work
MERGED=/jaiph/workspace
DELTA=/jaiph/delta
USE_OVERLAY=false

mkdir -p "$UPPER" "$WORK" "$DELTA/files"

# --- attempt fuse-overlayfs (needs --device /dev/fuse; may need SYS_ADMIN) ---
if command -v fuse-overlayfs >/dev/null 2>&1 && [ -e /dev/fuse ]; then
  if fuse-overlayfs \
       -o "lowerdir=$LOWER,upperdir=$UPPER,workdir=$WORK" \
       "$MERGED" 2>/dev/null; then
    USE_OVERLAY=true
  fi
fi

# --- fallback: copy workspace into container-local writable layer ---
if [ "$USE_OVERLAY" = false ]; then
  cp -a "$LOWER/." "$MERGED/"
  touch /tmp/jaiph-run-start
fi

# --- run the actual command ---
"$@"
status=$?

# --- extract delta ---
if [ "$USE_OVERLAY" = true ]; then
  fusermount -u "$MERGED" 2>/dev/null || fusermount3 -u "$MERGED" 2>/dev/null || true

  # Whiteout files (.wh.<name>) encode deletions in overlayfs
  find "$UPPER" -name '.wh.*' ! -name '.wh..wh..opq' -printf '%P\n' 2>/dev/null | \
    sed 's|/\.wh\.\([^/]*\)$|/\1|; s|^\.wh\.\([^/]*\)$|\1|' \
    > "$DELTA/deletions.txt" || true

  # Copy only changed/added files (skip whiteout markers)
  rsync -a --exclude='.wh.*' --exclude='.wh..wh..opq' "$UPPER/" "$DELTA/files/" 2>/dev/null || true
else
  # Changed/added files: anything newer than the timestamp marker
  (cd "$MERGED" && find . -newer /tmp/jaiph-run-start -not -path '.' -type f -print0 | \
    while IFS= read -r -d '' f; do
      rel="${f#./}"
      mkdir -p "$DELTA/files/$(dirname "$rel")"
      cp -- "$MERGED/$rel" "$DELTA/files/$rel"
    done) || true

  # Deleted files: present in lower but absent in merged
  (cd "$LOWER" && find . -not -path '.' -type f -print0 | \
    while IFS= read -r -d '' f; do
      rel="${f#./}"
      [ ! -e "$MERGED/$rel" ] && echo "$rel"
    done > "$DELTA/deletions.txt") || true
fi

# Ensure deletions.txt exists even if empty
[ -f "$DELTA/deletions.txt" ] || touch "$DELTA/deletions.txt"

exit "$status"
