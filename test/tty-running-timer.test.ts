import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function hasPython3(): boolean {
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

function runInPty(cliPath: string, workflowPath: string): { status: number | null; output: string } {
  const ptyRunner = `
import os
import pty
import select
import subprocess
import sys

cmd = sys.argv[1:]
master, slave = pty.openpty()
proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
chunks = []
while True:
    ready, _, _ = select.select([master], [], [], 0.1)
    if master in ready:
      try:
        data = os.read(master, 4096)
        if data:
          chunks.append(data)
      except OSError:
        pass
    if proc.poll() is not None:
      while True:
        try:
          data = os.read(master, 4096)
        except OSError:
          break
        if not data:
          break
        chunks.append(data)
      break

os.close(master)
sys.stdout.buffer.write(b"".join(chunks))
sys.exit(proc.returncode if proc.returncode is not None else 1)
`;
  const timeoutMs = 20_000;
  const result = spawnSync(
    "python3",
    ["-c", ptyRunner, process.execPath, cliPath, "run", workflowPath],
    { encoding: "utf8", timeout: timeoutMs },
  );
  return { status: result.status, output: result.stdout ?? "" };
}

test("ACCEPTANCE: TTY running timer updates and ends with PASS", () => {
  if (process.platform === "win32") {
    test.skip("PTY acceptance test is not portable to win32");
    return;
  }
  if (!hasPython3()) {
    test.skip("python3 not available for PTY harness");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "jaiph-tty-running-"));
  const cliPath = join(process.cwd(), "dist/src/cli.js");
  const workflowPath = join(root, "running_timer.jh");

  writeFileSync(
    workflowPath,
    ["workflow default {", "  sleep 3", "}"].join("\n"),
  );

  try {
    const run = runInPty(cliPath, workflowPath);
    assert.equal(run.status, 0, "jaiph run should exit with status 0 in PTY");

    const normalized = stripAnsi(run.output).replace(/\r/g, "\n");
    assert.match(
      normalized,
      /RUNNING workflow default \([0-9]+(\.[0-9]+)?s\)/,
      "TTY output should contain running timer line",
    );

    const times = Array.from(
      normalized.matchAll(/RUNNING workflow default \(([0-9]+(?:\.[0-9]+)?)s\)/g),
      (match) => Number(match[1]),
    );
    const distinctTimes: number[] = [];
    for (const time of times) {
      if (distinctTimes.length === 0 || distinctTimes[distinctTimes.length - 1] !== time) {
        distinctTimes.push(time);
      }
    }
    assert.ok(
      distinctTimes.length >= 2,
      `expected at least 2 running timer updates, got ${distinctTimes.length}: ${distinctTimes.join(", ")}`,
    );
    for (let i = 1; i < distinctTimes.length; i += 1) {
      assert.ok(
        distinctTimes[i] >= distinctTimes[i - 1],
        `running timer should be monotonic: ${distinctTimes.join(", ")}`,
      );
    }

    assert.match(
      normalized,
      /PASS workflow default/,
      "TTY output should end with PASS summary",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
