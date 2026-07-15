#!/usr/bin/env bash
# Install Jaiph from a local clone (no network download). Builds the
# standalone binary from the repo with `npm install` + `npm run build:standalone`
# (requires bun) and installs it to ${JAIPH_BIN_DIR:-$HOME/.local/bin}/jaiph.
# Also builds runtime/Dockerfile and tags it as the default sandbox image
# (ghcr.io/jaiphlang/jaiph-runtime:<version>, plus :nightly for older binaries)
# so Docker sandboxing matches the local CLI with no JAIPH_DOCKER_IMAGE override.
# Same single-binary artifact as the release-asset path in docs/install; only
# the origin of the binary differs (compiled locally vs. downloaded).
#
# Set JAIPH_SKIP_DOCKER_BUILD=1 to skip the runtime image build.
#
# Usage:
#   ./docs/install-from-local.sh           # install from repo containing this script
#   ./docs/install-from-local.sh /path/to/jaiph

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
# Resolve to absolute path so install script sees a consistent path
REPO_ROOT="$(cd "${REPO_ROOT}" && pwd)"

if [ ! -d "${REPO_ROOT}" ]; then
  echo "Error: not a directory: ${REPO_ROOT}" >&2
  exit 1
fi
if [ ! -f "${REPO_ROOT}/package.json" ]; then
  echo "Error: ${REPO_ROOT} does not look like the Jaiph repo (no package.json)" >&2
  exit 1
fi

export JAIPH_REPO_URL="${REPO_ROOT}"
echo "Installing from local source: ${JAIPH_REPO_URL}"
# Pass repo path as first arg so install uses it even if env is lost; install treats $1 as local path when it is a directory with package.json
"${SCRIPT_DIR}/install" "${REPO_ROOT}"

# Docker sandbox runs jaiph inside the container image, not the host binary.
# Tag the local build as the default ghcr.io image names jaiph resolves so
# sandbox runs pick it up without JAIPH_DOCKER_IMAGE.
if [ "${JAIPH_SKIP_DOCKER_BUILD:-0}" = "1" ]; then
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is required for install-from-local.sh (sandbox parity)" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker daemon is not running (required for install-from-local.sh)" >&2
  exit 1
fi
if [ ! -f "${REPO_ROOT}/runtime/Dockerfile" ]; then
  echo "Error: runtime/Dockerfile not found in ${REPO_ROOT}" >&2
  exit 1
fi

JAIPH_VERSION="$(node -pe "require(process.argv[1]).version" "${REPO_ROOT}/package.json")"
GHCR_REPO="ghcr.io/jaiphlang/jaiph-runtime"
DEFAULT_IMAGE="${GHCR_REPO}:${JAIPH_VERSION}"
NIGHTLY_IMAGE="${GHCR_REPO}:nightly"

echo ""
echo "▸ Building Docker runtime image (${DEFAULT_IMAGE})..."
if ! docker build \
  -t "${DEFAULT_IMAGE}" \
  -t "${NIGHTLY_IMAGE}" \
  -f "${REPO_ROOT}/runtime/Dockerfile" "${REPO_ROOT}"; then
  echo "Error: Docker runtime image build failed" >&2
  exit 1
fi
echo "✓ Built Docker runtime image ${DEFAULT_IMAGE} (also tagged ${NIGHTLY_IMAGE})"
