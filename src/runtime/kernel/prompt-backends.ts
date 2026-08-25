import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { parseStream, type StreamWriter } from "./stream-parser";
import { killProcessTreeEscalating } from "./portability";
import { scrubPromptEnv } from "./env-allowlist";
import {
  buildBackendArgs,
  isCustomCommand,
  DEFAULT_PROMPT_COMPLETION_GRACE_MS,
  DEFAULT_PROMPT_IDLE_TIMEOUT_MS,
  DEFAULT_PROMPT_MAX_DURATION_MS,
  type PromptConfig,
} from "./prompt-config";
import { commandExists, prepareClaudeEnv } from "./prompt-claude";
import { runCodexBackend } from "./prompt-codex";

// Subprocess backend dispatch (`runBackend`) and the three-layer prompt
// watchdog. Split out of `prompt.ts` so each prompt concern stays under the
// analyzability line cap. Codex (HTTP) lives in `prompt-codex.ts`.

type PromptWatchdog = {
  /** Record backend activity (an stdout/stderr chunk); resets the idle timer. */
  bump: () => void;
  /** Record that the backend emitted its terminal result event (Layer 1). */
  markComplete: (finalSoFar: string) => void;
  /** Stop all timers; call once the prompt has settled. */
  clear: () => void;
};

/**
 * Install the three watchdog layers over a spawned backend child process:
 *
 *  1. Completion grace — once the backend signals completion (`markComplete`),
 *     give it `completionGraceMs` to exit on its own, then terminate it and
 *     settle with success. Fixes the case where `claude -p` finishes the work
 *     but the process never exits (so the output stream never closes).
 *  2. Idle timeout — if no output arrives for `idleTimeoutMs`, treat the run
 *     as hung mid-work, terminate it, and settle with failure (status 1) so the
 *     runtime's retry/backoff loop takes over.
 *  3. Absolute cap — terminate and fail past `maxDurationMs` regardless of
 *     activity, as a backstop against slow-but-not-idle hangs.
 *
 * `onExpire(status, reason, finalSoFar)` fires at most once. By the time it
 * runs the child has already been sent SIGTERM (escalating to SIGKILL after a
 * short delay), so the caller only needs to settle its promise.
 */
export function installPromptWatchdog(
  child: ChildProcess,
  config: PromptConfig,
  backend: string,
  stderr: NodeJS.WritableStream,
  onExpire: (status: number, reason: string, finalSoFar: string) => void,
): PromptWatchdog {
  const completionGraceMs = config.completionGraceMs ?? DEFAULT_PROMPT_COMPLETION_GRACE_MS;
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_PROMPT_IDLE_TIMEOUT_MS;
  const maxDurationMs = config.maxDurationMs ?? DEFAULT_PROMPT_MAX_DURATION_MS;

  let fired = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let maxTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let lastFinal = "";

  const clear = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    if (graceTimer) clearTimeout(graceTimer);
    idleTimer = maxTimer = graceTimer = undefined;
  };

  const killChild = (): void => {
    const pid = child.pid;
    if (!pid) {
      return;
    }
    // Terminate the backend and any descendants it spawned. On win32 this
    // taskkill /T already force-kills the tree, so the SIGKILL escalation
    // is a documented no-op there (see killProcessTree).
    killProcessTreeEscalating(pid);
  };

  const expire = (status: number, reason: string): void => {
    if (fired) return;
    fired = true;
    clear();
    stderr.write(`jaiph: ${reason}; terminating ${backend} backend.\n`);
    killChild();
    onExpire(status, reason, lastFinal);
  };

  const armIdle = (): void => {
    if (idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => expire(1, `prompt produced no output for ${Math.round(idleTimeoutMs / 1000)}s`),
      idleTimeoutMs,
    );
    idleTimer.unref?.();
  };

  if (maxDurationMs > 0) {
    maxTimer = setTimeout(
      () => expire(1, `prompt exceeded the ${Math.round(maxDurationMs / 1000)}s maximum duration`),
      maxDurationMs,
    );
    maxTimer.unref?.();
  }
  armIdle();

  return {
    bump: () => armIdle(),
    markComplete: (finalSoFar: string) => {
      lastFinal = finalSoFar;
      if (completionGraceMs <= 0 || fired || graceTimer) return;
      graceTimer = setTimeout(
        () =>
          expire(
            0,
            `prompt completed but ${backend} did not exit within ${Math.round(completionGraceMs / 1000)}s`,
          ),
        completionGraceMs,
      );
      graceTimer.unref?.();
    },
    clear,
  };
}

/** Run the backend process and parse its streaming output. */
export function runBackend(
  config: PromptConfig,
  promptText: string,
  writer: StreamWriter,
  execEnv: NodeJS.ProcessEnv = process.env,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<{ final: string; status: number }> {
  // Codex uses HTTP API, not a CLI subprocess.
  if (config.backend === "codex") {
    return runCodexBackend(config, promptText, writer, stderr);
  }

  // Pre-flight check for claude backend
  if (config.backend === "claude" && !commandExists("claude")) {
    stderr.write(
      'jaiph: agent.backend is "claude" but the Claude CLI (claude) was not found in PATH. ' +
      'Install the Anthropic Claude CLI or set agent.backend = "cursor" (or JAIPH_AGENT_BACKEND=cursor).\n',
    );
    return Promise.resolve({ final: "", status: 1 });
  }

  return new Promise((resolve) => {
    const { command, args } = buildBackendArgs(config, promptText);
    const isClaude = config.backend === "claude";
    const isCustom = isCustomCommand(config);
    // The agent subprocess never inherits the workflow env verbatim: it gets
    // the base environment, JAIPH_* control keys, and this backend's own
    // credential keys only. `--env`-injected secrets (e.g. GITHUB_TOKEN) stay
    // with trusted `run` steps and never reach the model.
    let childEnv: NodeJS.ProcessEnv = scrubPromptEnv(execEnv, config.backend);
    if (isClaude) {
      const prepared = prepareClaudeEnv(childEnv, config.workspaceRoot);
      if (prepared.error) {
        stderr.write(`${prepared.error}\n`);
        resolve({ final: "", status: 1 });
        return;
      }
      if (prepared.warning) {
        stderr.write(`${prepared.warning}\n`);
      }
      childEnv = prepared.env;
    }
    // Cursor: stdin is not used (prompt is passed as arg), stderr passes through to caller.
    // Claude / custom: stdin receives prompt, stdout is parsed or collected raw.
    const useStdin = isClaude || isCustom;
    const child = nodeSpawn(command, args, {
      stdio: useStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      env: childEnv,
    });

    // Single-settle guard shared by the normal-exit path and every watchdog.
    let settled = false;
    let exitCode: number | null = null;
    // Extra stream to tear down on settle (the claude `merged` PassThrough).
    let extraStream: { destroy: () => void } | undefined;
    const settle = (final: string, status: number): void => {
      if (settled) return;
      settled = true;
      watchdog.clear();
      // Release Node's handles on the child's pipes. Without this, a descendant
      // that outlives the child while holding the stdout write end (the classic
      // `claude -p` hang) keeps these streams — and the event loop — alive even
      // after we've terminated the child and resolved. Destroying here lets the
      // runtime move on (and ultimately exit) regardless.
      try {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        extraStream?.destroy();
      } catch {
        // best-effort cleanup
      }
      resolve({ final, status });
    };

    // Watchdog layers (completion grace / idle / absolute cap). For custom
    // commands only layers 2 and 3 apply — there is no result event to trigger
    // layer 1, so markComplete is simply never called.
    const watchdog = installPromptWatchdog(
      child,
      config,
      isCustom ? command : config.backend,
      stderr,
      (status, _reason, finalSoFar) => settle(finalSoFar, status),
    );

    child.on("error", (err) => {
      stderr.write(`jaiph: failed to start ${command}: ${err.message}\n`);
      settle("", 1);
    });
    child.on("exit", (code) => {
      exitCode = code;
    });

    if (useStdin && child.stdin) {
      child.stdin.write(promptText);
      child.stdin.end();
    }

    // Custom commands: collect raw stdout without JSON stream parsing.
    if (isCustom) {
      let final = "";
      let wroteHeader = false;
      child.stderr?.pipe(stderr);
      child.stderr?.on("data", () => watchdog.bump());
      child.stdout?.on("data", (chunk: Buffer) => {
        watchdog.bump();
        const text = chunk.toString();
        if (!wroteHeader) {
          writer.writeFinal("Final answer:\n");
          wroteHeader = true;
        }
        writer.writeFinal(text);
        final += text;
      });
      child.on("close", (code) => {
        settle(final, code ?? exitCode ?? 0);
      });
      return;
    }

    let parseInput: import("node:stream").Readable;
    if (isClaude) {
      // Claude: merge stdout + stderr for parsing (matches bash `2>&1 |` behavior)
      const merged = new PassThrough();
      child.stdout?.pipe(merged);
      child.stderr?.pipe(merged);
      child.on("close", () => merged.end());
      parseInput = merged;
      extraStream = merged;
    } else {
      // Cursor: parse only stdout; pipe stderr through to process stderr
      parseInput = child.stdout!;
      child.stderr?.pipe(stderr);
    }

    parseStream(parseInput, writer, {
      onComplete: (finalSoFar) => watchdog.markComplete(finalSoFar),
    }).then((final) => {
      // Stream ended — process closed, or the watchdog already killed it and
      // settled (in which case `settle` here is a no-op).
      const close = (code: number | null): void => settle(final, code ?? exitCode ?? 0);
      if (child.exitCode !== null || exitCode !== null) {
        close(child.exitCode ?? exitCode);
      } else {
        child.on("close", (code) => close(code));
      }
    });

    // Reset the idle watchdog on every chunk. Attached after parseStream so the
    // cursor backend (whose stdout IS the parse input) does not drop the first
    // chunk to a premature switch into flowing mode.
    child.stdout?.on("data", () => watchdog.bump());
    child.stderr?.on("data", () => watchdog.bump());
  });
}
