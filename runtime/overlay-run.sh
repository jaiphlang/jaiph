#!/usr/bin/env bash
set -euo pipefail
LOWER=/jaiph/workspace-ro
UPPER=/tmp/overlay-upper
WORK=/tmp/overlay-work
MERGED=/jaiph/workspace
RUN_DIR=/jaiph/run
mkdir -p "$UPPER" "$WORK" "$MERGED"

if ! command -v fuse-overlayfs >/dev/null 2>&1; then
  printf 'E_DOCKER_OVERLAY fuse-overlayfs not found in image; install it or set JAIPH_DOCKER_NO_OVERLAY=1 on the host to use the copy sandbox path\n' >&2
  exit 78
fi
if [ ! -e /dev/fuse ]; then
  printf 'E_DOCKER_OVERLAY /dev/fuse not present in container; pass --device /dev/fuse or set JAIPH_DOCKER_NO_OVERLAY=1 to use the copy sandbox path\n' >&2
  exit 78
fi
if ! fuse-overlayfs -o "lowerdir=$LOWER,upperdir=$UPPER,workdir=$WORK,allow_other" "$MERGED" 2>/tmp/jaiph-fuse-overlay.err; then
  reason="$(tr '\n' ' ' </tmp/jaiph-fuse-overlay.err | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
  printf 'E_DOCKER_OVERLAY fuse-overlayfs mount failed: %s\n' "$reason" >&2
  exit 78
fi

cd "$MERGED"

# Drop to host UID/GID after mounting overlay as root.
if [ -n "${JAIPH_HOST_UID:-}" ] && [ -n "${JAIPH_HOST_GID:-}" ] && command -v setpriv >/dev/null 2>&1; then
  chown "$JAIPH_HOST_UID:$JAIPH_HOST_GID" "$RUN_DIR" 2>/dev/null || true
  exec setpriv --reuid="$JAIPH_HOST_UID" --regid="$JAIPH_HOST_GID" --clear-groups -- "$@"
fi
exec "$@"
