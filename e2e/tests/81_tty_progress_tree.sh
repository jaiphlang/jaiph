#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "tty_progress_tree"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "TTY run renders running timer and stable tree projection"

if ! command -v python3 >/dev/null 2>&1; then
  e2e::fail "python3 is required for PTY TTY test (e2e/tests/81_tty_progress_tree.sh)"
fi

cat > "${TEST_DIR}/tty_tree.jh" <<'EOF'
function leaf_fn() {
  sleep 2
}

workflow leaf {
  leaf_fn
}

workflow default {
  run leaf
}
EOF

# We use Python here to spawn the CLI within a pseudoterminal (PTY), simulating a real TTY environment.
# This allows us to accurately capture and test the CLI's interactive TTY rendering behavior, which 
# cannot be tested with regular process spawning and redirection in Bash.
set +e
tty_out="$(
  python3 - "${TEST_DIR}/tty_tree.jh" <<'PY'
import os
import pty
import select
import subprocess
import sys

workflow_path = sys.argv[1]
cmd = ["jaiph", "run", workflow_path]

master_fd, slave_fd = pty.openpty()
proc = subprocess.Popen(cmd, stdin=slave_fd, stdout=slave_fd, stderr=slave_fd, close_fds=True)
os.close(slave_fd)

chunks = []
while True:
    ready, _, _ = select.select([master_fd], [], [], 0.1)
    if master_fd in ready:
        try:
            data = os.read(master_fd, 4096)
        except OSError:
            data = b""
        if data:
            chunks.append(data)
    if proc.poll() is not None:
        while True:
            try:
                data = os.read(master_fd, 4096)
            except OSError:
                break
            if not data:
                break
            chunks.append(data)
        break

os.close(master_fd)
sys.stdout.buffer.write(b"".join(chunks))
sys.exit(proc.returncode if proc.returncode is not None else 1)
PY
)"
tty_status=$?
set -e

e2e::assert_equals "${tty_status}" "0" "jaiph run exits 0 in PTY"

normalized_input="${tty_out//$'\r'/$'\n'}"
normalized="$(e2e::normalize_output "${normalized_input}")"
e2e::assert_contains "${normalized}" "▸ RUNNING workflow default (<time>)" "TTY output includes running timer line"

# Canonicalize dynamic TTY refreshes: keep first RUNNING line, then deterministic tree/result lines.
tree_projection="$(
  printf '%s\n' "${normalized}" | awk '
    /^Jaiph: Running tty_tree\.jh$/ { print; next }
    /^workflow default$/ { print; next }
    /RUNNING workflow default \(\<time\>\)/ {
      if (!seen_running) {
        # Canonicalize possible TTY redraw variants to one stable line.
        print "▸ RUNNING workflow default (<time>)"
        seen_running=1
      }
      next
    }
    /^  ·   ✓ <time>$/ { print; next }
    /^  ✓ <time>$/ { print; next }
    /^✓ PASS workflow default \(\<time\>\)$/ { print; next }
  '
)"

expected_tree=$(printf '%s\n' \
  'Jaiph: Running tty_tree.jh' \
  'workflow default' \
  '▸ RUNNING workflow default (<time>)' \
  '  ·   ✓ <time>' \
  '  ✓ <time>' \
  '✓ PASS workflow default (<time>)')
expected_tree="${expected_tree%$'\n'}"

e2e::assert_equals "${tree_projection}" "${expected_tree}" "TTY projected tree matches expected flow"
e2e::pass "TTY progress timer and tree projection are stable"
