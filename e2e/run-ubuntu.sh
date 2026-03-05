#!/usr/bin/env bash
# Run e2e (or a single test) inside Ubuntu 22.04 container to match CI.
# Usage: ./e2e/run-ubuntu.sh [e2e/tests/95_say_hello_failure_output.sh]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${1:-./e2e/test_all.sh}"

docker build -t jaiph-e2e -f "${ROOT_DIR}/e2e/Dockerfile" "${ROOT_DIR}"
docker run --rm jaiph-e2e bash -c "${SCRIPT}"
