#!/usr/bin/env bash
# Run this from project root to capture test output: ./scripts/run-test-capture.sh
set -e
cd "$(dirname "$0")/.."
npm run build 2>&1
echo "--- RUNNING TESTS ---"
node --test dist/test/sample-build.test.js 2>&1 | head -80
