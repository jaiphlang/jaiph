import { existsSync, accessSync, mkdirSync, cpSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir, tmpdir } from "node:os";

// Command-in-PATH detection and Claude CLI writable-config-dir preparation.
// Split out of `prompt.ts` so each prompt concern stays under the analyzability
// line cap.

/** Check if a command exists in PATH. */
export function commandExists(cmd: string): boolean {
  if (!cmd) return false;
  if (cmd.includes("/")) {
    try {
      accessSync(cmd, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, cmd);
    try {
      accessSync(full, fsConstants.X_OK);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

function isDirWritable(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export type ClaudeEnvPreparation = {
  env: NodeJS.ProcessEnv;
  warning?: string;
  error?: string;
};

/**
 * Ephemeral Claude config dir fallback: under the run dir when set, else system temp.
 */
export function resolveClaudeFallbackConfigDir(execEnv: NodeJS.ProcessEnv): string {
  const runDir = execEnv.JAIPH_RUN_DIR;
  if (runDir) {
    return join(runDir, "claude-config");
  }
  return join(tmpdir(), `jaiph-claude-${process.pid}`);
}

/**
 * Ensure Claude CLI has a writable config/session directory.
 * Falls back to the ephemeral run directory (or system temp) when home config is not writable.
 */
export function prepareClaudeEnv(execEnv: NodeJS.ProcessEnv, workspaceRoot: string): ClaudeEnvPreparation {
  // Final fallback to os.homedir() so USERPROFILE-only environments (Windows)
  // resolve; an explicit HOME in execEnv still wins.
  const home = execEnv.HOME || process.env.HOME || homedir() || "";
  const defaultConfigDir = home ? join(home, ".claude") : "";
  const configuredDir = execEnv.CLAUDE_CONFIG_DIR || defaultConfigDir;

  if (configuredDir) {
    try {
      mkdirSync(join(configuredDir, "session-env"), { recursive: true });
      if (isDirWritable(join(configuredDir, "session-env"))) {
        return { env: execEnv };
      }
    } catch {
      // Fallback to ephemeral config under the run dir or system temp.
    }
  }

  const fallbackConfigDir = resolveClaudeFallbackConfigDir(execEnv);
  try {
    mkdirSync(fallbackConfigDir, { recursive: true });
    // Seed the fallback with the user's existing config (auth, settings) so the
    // Claude CLI keeps its credentials when only session-env was unwritable.
    if (
      configuredDir &&
      configuredDir !== fallbackConfigDir &&
      existsSync(configuredDir) &&
      !existsSync(join(fallbackConfigDir, "config.json"))
    ) {
      try {
        cpSync(configuredDir, fallbackConfigDir, { recursive: true });
      } catch {
        // If source config is malformed/inaccessible, continue with clean fallback.
      }
    }
    const fallbackSessionDir = join(fallbackConfigDir, "session-env");
    mkdirSync(fallbackSessionDir, { recursive: true });
    if (!isDirWritable(fallbackSessionDir)) {
      return {
        env: execEnv,
        error:
          `jaiph: Claude backend requires writable session state, but cannot write ` +
          `'${fallbackSessionDir}'. Fix permissions or set CLAUDE_CONFIG_DIR to a writable path.`,
      };
    }
    return {
      env: { ...execEnv, CLAUDE_CONFIG_DIR: fallbackConfigDir },
      warning:
        `jaiph: Claude config dir '${configuredDir || "<unset>"}' is not writable; ` +
        `using ephemeral fallback '${fallbackConfigDir}'.`,
    };
  } catch {
    return {
      env: execEnv,
      error:
        `jaiph: Claude backend could not initialize writable session state. ` +
        `Set CLAUDE_CONFIG_DIR to a writable directory and retry.`,
    };
  }
}
