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

# Given
e2e::file "tty_tree.jh" <<'EOF'
script leaf_fn() {
  sleep 4
}

workflow leaf {
  run leaf_fn
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
import re
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
captured = b"".join(chunks)
text = captured.decode("utf-8", errors="ignore")
# Mirror shell-side normalization at a coarse level for robust detection across
# PTY redraw/control sequences and chunk boundaries.
text = text.replace("\r", "\n")
text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)
running_seen = "RUNNING workflow default" in text
sys.stdout.write(f"__JAIPH_TTY_RUNNING_SEEN__={'1' if running_seen else '0'}\n")
sys.stdout.buffer.write(captured)
sys.exit(proc.returncode if proc.returncode is not None else 1)
PY
)"
tty_status=$?
set -e

# Then
e2e::assert_equals "${tty_status}" "0" "jaiph run exits 0 in PTY"

normalized_input="${tty_out//$'\r'/$'\n'}"
normalized="$(e2e::normalize_output "${normalized_input}")"
e2e::assert_contains "${normalized}" "__JAIPH_TTY_RUNNING_SEEN__=1" "TTY stream observed RUNNING frame during live render"

# Canonicalize dynamic TTY refreshes and keep stable tree lines only.
tree_projection="$(
  printf '%s\n' "${normalized}" | awk '
    /^Jaiph: Running tty_tree\.jh$/ { print; next }
    /^workflow default$/ { print; next }
    /^  ·   ✓ script leaf_fn \(<time>\)$/ { print; next }
    /^  ✓ workflow leaf \(<time>\)$/ { print; next }
  '
)"

e2e::assert_equals "${tree_projection}" "Jaiph: Running tty_tree.jh
workflow default
  ·   ✓ script leaf_fn (<time>)
  ✓ workflow leaf (<time>)" "TTY projected tree matches expected flow"

e2e::expect_out_files "tty_tree.jh" 0

e2e::pass "TTY progress timer and tree projection are stable"
