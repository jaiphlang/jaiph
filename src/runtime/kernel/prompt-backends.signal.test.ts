// A backend process killed by a signal (e.g. an OOM SIGKILL) reports
// `code === null`. `runBackend` must treat that as a failure named by the
// signal — not the old silent status 0 that passed truncated output and skipped
// retry/recover. The one exception is the watchdog's completion-grace kill,
// which terminates a backend that already produced its final result and must
// still report success. These tests drive `runBackend` through the
// `_backendSpawn` seam with a fake child for each of the three subprocess
// backends (claude, cursor, custom).

import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { runBackend, type PromptConfig } from "./prompt";
import { _backendSpawn } from "./prompt-backends";

const FAKE_PID = 987654;

function makeConfig(overrides: Partial<PromptConfig> = {}): PromptConfig {
  return {
    backend: "cursor",
    agentCommand: "cursor-agent",
    model: "",
    workspaceRoot: "/ws",
    trustedWorkspace: "/ws",
    cursorFlags: [],
    claudeFlags: [],
    codexApiKey: "",
    codexApiUrl: "https://api.openai.com/v1/chat/completions",
    promptFinalFile: "",
    ...overrides,
  };
}

type FakeChild = ChildProcess & { stdout: PassThrough; stderr: PassThrough };

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild & { [k: string]: unknown };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  (child as { stdin: unknown }).stdin = {
    write: () => true,
    end: () => {},
    destroy: () => {},
  };
  (child as { pid: number }).pid = FAKE_PID;
  (child as { exitCode: number | null }).exitCode = null;
  (child as { signalCode: NodeJS.Signals | null }).signalCode = null;
  (child as { kill: () => boolean }).kill = () => true;
  return child as unknown as FakeChild;
}

const noopWriter = { writeReasoning: () => {}, writeFinal: () => {} };

function withSpawn(child: ChildProcess, fn: () => Promise<void>): Promise<void> {
  const orig = _backendSpawn.spawn;
  _backendSpawn.spawn = (() => child) as typeof _backendSpawn.spawn;
  return fn().finally(() => {
    _backendSpawn.spawn = orig;
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- Signal-kill after partial output: non-zero status + signal-named error ---

describe("runBackend: signal kill after partial output fails with the signal name", () => {
  // The claude backend pre-flight requires `claude` on PATH; install a stub.
  let claudeRoot: string | undefined;
  let origPath: string | undefined;
  afterEach(() => {
    if (origPath !== undefined) {
      process.env.PATH = origPath;
      origPath = undefined;
    }
    if (claudeRoot) {
      rmSync(claudeRoot, { recursive: true, force: true });
      claudeRoot = undefined;
    }
  });

  it("cursor backend: close(null, SIGKILL) → status 1 and 'killed by SIGKILL'", async () => {
    const child = makeFakeChild();
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (c: Buffer) => (err += c.toString()));
    await withSpawn(child, async () => {
      const p = runBackend(makeConfig({ backend: "cursor" }), "hi", noopWriter, {}, stderr);
      // Partial output, then an external signal kill (no result event, no code).
      child.stdout.write('{"type":"assistant","message":{"content":"partial"}}\n');
      await delay(10);
      (child as { signalCode: NodeJS.Signals | null }).signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      child.stdout.end();
      const result = await p;
      assert.notEqual(result.status, 0, "signal kill must not report success");
      assert.equal(result.status, 1);
      assert.match(err, /killed by SIGKILL/);
    });
  });

  it("custom backend: close(null, SIGKILL) → status 1 and 'killed by SIGKILL'", async () => {
    const child = makeFakeChild();
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (c: Buffer) => (err += c.toString()));
    await withSpawn(child, async () => {
      const p = runBackend(
        makeConfig({ backend: "cursor", agentCommand: "/opt/my-agent" }),
        "hi",
        noopWriter,
        {},
        stderr,
      );
      child.stdout.write("partial answer");
      await delay(10);
      (child as { signalCode: NodeJS.Signals | null }).signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      const result = await p;
      assert.notEqual(result.status, 0, "signal kill must not report success");
      assert.equal(result.status, 1);
      assert.match(err, /killed by SIGKILL/);
    });
  });

  it("claude backend: close(null, SIGKILL) → status 1 and 'killed by SIGKILL'", async () => {
    claudeRoot = mkdtempSync(join(tmpdir(), "jaiph-backend-signal-claude-"));
    // commandExists("claude") resolves an executable on PATH; stub one.
    writeFileSync(join(claudeRoot, "claude"), "#!/usr/bin/env bash\n", { mode: 0o755 });
    chmodSync(join(claudeRoot, "claude"), 0o755);
    origPath = process.env.PATH;
    process.env.PATH = `${claudeRoot}${delimiter}${origPath ?? ""}`;

    const child = makeFakeChild();
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (c: Buffer) => (err += c.toString()));
    await withSpawn(child, async () => {
      const execEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: claudeRoot };
      const p = runBackend(
        makeConfig({ backend: "claude", workspaceRoot: claudeRoot!, trustedWorkspace: claudeRoot! }),
        "hi",
        noopWriter,
        execEnv,
        stderr,
      );
      child.stdout.write('{"type":"assistant","message":{"content":"partial"}}\n');
      await delay(10);
      (child as { signalCode: NodeJS.Signals | null }).signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      // Claude merges stdout+stderr and ends the merged stream on the child's
      // `close` event, which resolves the parse promise.
      child.emit("close", null, "SIGKILL");
      const result = await p;
      assert.notEqual(result.status, 0, "signal kill must not report success");
      assert.equal(result.status, 1);
      assert.match(err, /killed by SIGKILL/);
    });
  });
});

// --- Completion-grace kill: still success ---

describe("runBackend: completion-grace kill still reports success", () => {
  let origProcessKill: typeof process.kill | undefined;
  afterEach(() => {
    if (origProcessKill) {
      (process as { kill: typeof process.kill }).kill = origProcessKill;
      origProcessKill = undefined;
    }
  });

  it("cursor backend: a result event then a graced signal kill → status 0", async () => {
    // Stub process.kill so the watchdog's real SIGTERM/SIGKILL to the fake pid
    // never touches a real process group.
    origProcessKill = process.kill;
    (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: NodeJS.Signals) => {
      if (Math.abs(pid) === FAKE_PID) return true;
      return origProcessKill!(pid, signal);
    }) as typeof process.kill;

    const child = makeFakeChild();
    const stderr = new PassThrough();
    await withSpawn(child, async () => {
      // Tiny grace window so the watchdog fires quickly after completion.
      const p = runBackend(
        makeConfig({ backend: "cursor", completionGraceMs: 20, idleTimeoutMs: 0, maxDurationMs: 0 }),
        "hi",
        noopWriter,
        {},
        stderr,
      );
      // Final text plus the terminal result event: the answer is complete.
      child.stdout.write('{"type":"assistant","message":{"content":"done"}}\n');
      child.stdout.write('{"type":"result","result":"done"}\n');
      // Do NOT end the stream: the backend "never exits", so the completion-grace
      // watchdog layer kills it and settles with success.
      await delay(60);
      // The watchdog's kill surfaces later as a signal close; it must not
      // overturn the already-settled success.
      (child as { signalCode: NodeJS.Signals | null }).signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      const result = await p;
      assert.equal(result.status, 0, "a graced completion keeps status 0 despite the signal kill");
      assert.match(result.final, /done/);
    });
  });
});
