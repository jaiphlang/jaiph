#!/usr/bin/env bash
# Build a local linux runner image from this clone.
# docs/install-from-local.sh does not do this — that script installs the host
# binary only. This compiles the linux standalones and docker-builds
# runtime/Dockerfile.
#
# Requires: npm, bun, docker
#
# Usage:
#   ./docs/build-jaiph-dev-image.sh
#   JAIPH_DEV_IMAGE=my/jaiph ./docs/build-jaiph-dev-image.sh
#
# Tags ${JAIPH_DEV_IMAGE:-ghcr.io/jaiphlang/jaiph-runtime} and :latest
# for linux/${host-arch}. The Dockerfile COPYs both linux binaries.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMAGE="${JAIPH_DEV_IMAGE:-ghcr.io/jaiphlang/jaiph-runtime}"

case "$(uname -m)" in
  arm64|aarch64) DOCKER_ARCH=arm64 ;;
  x86_64|amd64) DOCKER_ARCH=amd64 ;;
  *)
    echo "build-jaiph-dev-image: unsupported uname -m: $(uname -m)" >&2
    exit 1
    ;;
esac

for cmd in npm bun docker; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "build-jaiph-dev-image: ${cmd} is required" >&2
    exit 1
  fi
done

cd "${REPO_ROOT}"
npm run build
bun build --compile --target=bun-linux-arm64 ./src/cli.ts --outfile runtime/jaiph-linux-arm64
bun build --compile --target=bun-linux-x64 ./src/cli.ts --outfile runtime/jaiph-linux-x64
chmod +x runtime/jaiph-linux-arm64 runtime/jaiph-linux-x64

docker build --platform "linux/${DOCKER_ARCH}" \
  -f runtime/Dockerfile \
  -t "${IMAGE}:latest" \
  -t "${IMAGE}" \
  runtime/

echo "Tagged ${IMAGE} and ${IMAGE}:latest (linux/${DOCKER_ARCH})"
