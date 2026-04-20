#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/e2e/lib/common.sh"
trap e2e::cleanup EXIT

e2e::prepare_test_env "tty_async_progress"
TEST_DIR="${JAIPH_E2E_TEST_DIR}"

e2e::section "TTY run async renders per-branch progress events in real time"

if ! command -v python3 >/dev/null 2>&1; then
  e2e::fail "python3 is required for PTY TTY test (e2e/tests/131_tty_async_progress.sh)"
fi

# Given — two async branches, each emitting multiple progress events over time
e2e::file "tty_async.jh" <<'EOF'
script slow_a = `sleep 1 && echo "a-script-done"`

script slow_b = `sleep 1 && echo "b-script-done"`

workflow branch_a() {
  log "a-start"
  run slow_a()
  log "a-end"
  return "result-a"
}

workflow branch_b() {
  log "b-start"
  run slow_b()
  log "b-end"
  return "result-b"
}

workflow default() {
  const ha = run async branch_a()
  const hb = run async branch_b()
  log ha
  log hb
}
EOF

# Spawn jaiph run under a real PTY so the CLI takes the TTY rendering path.
set +e
tty_out="$(
  python3 - "${TEST_DIR}/tty_async.jh" <<'PY'
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
# Normalize for robust detection across PTY redraw/control sequences
text = text.replace("\r", "\n")
clean = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)

# Check that RUNNING frame was observed during live render
running_seen = "RUNNING workflow default" in clean
sys.stdout.write(f"__JAIPH_TTY_RUNNING_SEEN__={'1' if running_seen else '0'}\n")

# Check for orphaned ANSI escape sequences after stripping known CSI patterns.
# A well-formed stream should have no leftover \x1b after CSI removal.
orphaned_esc = "\x1b" in clean
sys.stdout.write(f"__JAIPH_TTY_ANSI_CLEAN__={'1' if not orphaned_esc else '0'}\n")

sys.stdout.buffer.write(captured)
sys.exit(proc.returncode if proc.returncode is not None else 1)
PY
)"
tty_status=$?
set -e

# Then — exit code
e2e::assert_equals "${tty_status}" "0" "jaiph run async exits 0 in PTY"

normalized_input="${tty_out//$'\r'/$'\n'}"
normalized="$(e2e::normalize_output "${normalized_input}")"

# assert_contains: PTY output includes ANSI escape sequences and redraw frames that make exact match infeasible
e2e::assert_contains "${normalized}" "__JAIPH_TTY_RUNNING_SEEN__=1" "TTY stream observed RUNNING frame during async live render"

# assert_contains: orphaned-escape check is a single flag extracted from the PTY stream
e2e::assert_contains "${normalized}" "__JAIPH_TTY_ANSI_CLEAN__=1" "No orphaned ANSI escape sequences in PTY output"

# --- Per-branch progress events appear under correct branch nodes ---

# assert_contains: async interleaving order is nondeterministic in live PTY output
e2e::assert_contains "${normalized}" "workflow branch_a" "branch_a appears in progress tree"
e2e::assert_contains "${normalized}" "workflow branch_b" "branch_b appears in progress tree"

# Subscript ₁ prefixes branch_a events, ₂ prefixes branch_b events
# assert_contains: PTY redraws make exact full-output match infeasible
e2e::assert_contains "${normalized}" "₁" "branch ₁ subscript present"
e2e::assert_contains "${normalized}" "₂" "branch ₂ subscript present"

# Log events from each branch appear with their branch subscript
# assert_contains: async interleaving is nondeterministic
e2e::assert_contains "${normalized}" "a-start" "branch_a log a-start present"
e2e::assert_contains "${normalized}" "a-end" "branch_a log a-end present"
e2e::assert_contains "${normalized}" "b-start" "branch_b log b-start present"
e2e::assert_contains "${normalized}" "b-end" "branch_b log b-end present"

# Script steps appear under their branches
# assert_contains: async interleaving is nondeterministic
e2e::assert_contains "${normalized}" "script slow_a" "script slow_a appears in progress tree"
e2e::assert_contains "${normalized}" "script slow_b" "script slow_b appears in progress tree"

# --- Final frame: both branches completed with resolved return values ---

# assert_contains: PTY redraws make exact match infeasible
e2e::assert_contains "${normalized}" "result-a" "handle ha resolved to result-a"
e2e::assert_contains "${normalized}" "result-b" "handle hb resolved to result-b"

# Both branches show completion markers
# assert_contains: PTY redraws make exact match infeasible
e2e::assert_contains "${normalized}" "workflow branch_a (<time>)" "branch_a completed with timing"
e2e::assert_contains "${normalized}" "workflow branch_b (<time>)" "branch_b completed with timing"

# Overall PASS
# assert_contains: PTY redraws make exact match infeasible
e2e::assert_contains "${normalized}" "PASS workflow default" "workflow default passed"

# Canonicalize dynamic TTY refreshes and verify stable tree structure.
# Extract only the lines we can stably match regardless of async interleaving order.
tree_projection="$(
  printf '%s\n' "${normalized}" | awk '
    /^Jaiph: Running tty_async\.jh$/ { print; next }
    /^workflow default$/ { print; next }
    /^ .₁.+ workflow branch_a \(<time>\)$/ { print; next }
    /^ .₂.+ workflow branch_b \(<time>\)$/ { print; next }
    /PASS workflow default/ { print; next }
  '
)"

# assert_contains: we extract stable subset lines; the full projection order depends on async timing
e2e::assert_contains "${tree_projection}" "Jaiph: Running tty_async.jh" "tree projection: header"
e2e::assert_contains "${tree_projection}" "workflow default" "tree projection: root workflow"
e2e::assert_contains "${tree_projection}" "PASS workflow default" "tree projection: final PASS"

e2e::pass "TTY async progress renders per-branch events correctly"
