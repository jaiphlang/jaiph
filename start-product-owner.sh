#!/bin/sh
# Start the product-owner HTTP + MCP server in Docker.
# Usage: ./start-product-owner.sh
#   JAIPH_PO_IMAGE   default ghcr.io/jaiphlang/jaiph-runtime
#                    Rebuild locally with ./docs/build-jaiph-dev-image.sh
#                    (install-from-local.sh does not). Has jaiph + python3 + git;
#                    the product-owner def needs `claude` on PATH — point
#                    this at a derived image, or layer the CLI yourself.
#   JAIPH_PO_PORT    default 5247
#   JAIPH_SERVE_TOKEN  optional. Unset = --allow-anonymous (host publish is
#                    127.0.0.1). Set to require Authorization: Bearer.
# State:
#   queue-state.md — host binds at .jaiph/queue-state.md and
#                    .jaiph/queue-state.md.lock (gitignored). Scripts see the
#                    default path $JAIPH_WORKSPACE/.jaiph/queue-state.md (also
#                    $JAIPH_QUEUE_STATE). /work is :ro; both files must be
#                    writable mounts or queue.py cannot take its lock.
#   runs/          — named volume jaiph-po-state (not virtiofs), at
#                    .jaiph/product-owner/runs.
# Host .jaiph/runs is tmpfs-masked so serve and the agent cannot see it.
# Claude creds: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN on the host.
# Those are backend credentials, not `use` grants — do not --env them.
set -e
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
: "${JAIPH_PO_IMAGE:=ghcr.io/jaiphlang/jaiph-runtime}"
: "${JAIPH_PO_PORT:=5247}"
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf '%s\n' "start-product-owner: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN" >&2
  exit 1
fi
touch "$root/DONE.md"
# Mount points must exist on the host: /work is :ro, so Docker cannot mkdir them.
mkdir -p "$root/.jaiph/product-owner"
# State + lock must both be writable binds. /work/.jaiph is on the :ro
# workspace mount; bind-mounting only the state file leaves the sibling
# `.lock` on the read-only tree.
touch "$root/.jaiph/queue-state.md" "$root/.jaiph/queue-state.md.lock"
# Named volumes are created root:root; the image runs as uid jaiph (10001).
docker volume create jaiph-po-state >/dev/null
docker run --rm --user root --entrypoint sh \
  -v jaiph-po-state:/data \
  "$JAIPH_PO_IMAGE" \
  -c 'mkdir -p /data/runs && chown -R jaiph:jaiph /data'
if docker inspect jaiph-product-owner >/dev/null 2>&1; then
  docker rm -f jaiph-product-owner >/dev/null
fi
printf '%s\n' \
  "product-owner: http://127.0.0.1:${JAIPH_PO_PORT}/docs" \
  "product-owner: http://127.0.0.1:${JAIPH_PO_PORT}/mcp"
if [ -n "${JAIPH_SERVE_TOKEN:-}" ]; then
  printf '%s\n' "product-owner: Authorization: Bearer ${JAIPH_SERVE_TOKEN}"
else
  printf '%s\n' "product-owner: open (no auth; published on 127.0.0.1)"
fi
set -- \
  --rm \
  --name jaiph-product-owner \
  -p "127.0.0.1:${JAIPH_PO_PORT}:5247" \
  -e JAIPH_WORKSPACE=/work \
  -e JAIPH_QUEUE_STATE=/work/.jaiph/queue-state.md \
  -e JAIPH_RUNS_DIR=/work/.jaiph/product-owner/runs \
  -v "$root:/work:ro" \
  -v "$root/QUEUE.md:/work/QUEUE.md" \
  -v "$root/DONE.md:/work/DONE.md" \
  -v "$root/.jaiph/queue-state.md:/work/.jaiph/queue-state.md" \
  -v "$root/.jaiph/queue-state.md.lock:/work/.jaiph/queue-state.md.lock" \
  -v jaiph-po-state:/work/.jaiph/product-owner \
  --tmpfs /work/.jaiph/runs \
  -w /work
if [ -n "${JAIPH_SERVE_TOKEN:-}" ]; then
  set -- "$@" -e "JAIPH_SERVE_TOKEN=${JAIPH_SERVE_TOKEN}"
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  set -- "$@" -e ANTHROPIC_API_KEY
fi
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  set -- "$@" -e CLAUDE_CODE_OAUTH_TOKEN
fi
exec docker run "$@" \
  "$JAIPH_PO_IMAGE" \
  jaiph serve --host 0.0.0.0 --port 5247 --allow-anonymous \
    .jaiph/product_owner.jh
