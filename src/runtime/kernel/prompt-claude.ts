import {
  existsSync,
  accessSync,
  mkdirSync,
  mkdtempSync,
  chmodSync,
  copyFileSync,
  statSync,
  rmSync,
  constants as fsConstants,
} from "node:fs";
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
  /**
   * Ephemeral config dir created for the fallback; the caller removes it when
   * the run ends. Unset when the home config was writable (no fallback made).
   */
  cleanupDir?: string;
};

/**
 * Top-level Claude config files to seed into the ephemeral fallback — only what
 * the CLI needs to authenticate and start. Directories (e.g. `projects/` session
 * history) are deliberately excluded so no credentials or history are copied
 * wholesale.
 */
const CLAUDE_SEED_FILES = [".credentials.json", "settings.json", "settings.local.json"];

/** Remove an ephemeral Claude config dir at run end (best-effort, no-op if unset). */
export function removeClaudeConfigDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Copy only the seed files (if present as files) from the home config dir. */
function seedClaudeConfig(sourceDir: string, destDir: string): void {
  for (const name of CLAUDE_SEED_FILES) {
    const src = join(sourceDir, name);
    try {
      if (statSync(src).isFile()) {
        copyFileSync(src, join(destDir, name));
      }
    } catch {
      // Missing or unreadable seed file: start the fallback without it.
    }
  }
}

/**
 * Ensure Claude CLI has a writable config/session directory.
 * Falls back to a private `0700` temp directory (never under the run dir) when
 * the home config is not writable, seeding it with only the auth/settings files.
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

  // The home config is not writable (commonly a read-only `~/.claude`). Create a
  // private, ephemeral config dir under the OS temp dir — never under the run
  // directory, so no credentials or project history land in `.jaiph/runs`, where
  // scripts (via `JAIPH_RUN_DIR`), `jaiph serve`, and CI artifact upload could
  // read them. `mkdtemp` already creates at `0700`; the explicit `chmod` pins
  // the mode regardless of umask so the seeded credentials stay owner-only.
  let fallbackConfigDir: string;
  try {
    fallbackConfigDir = mkdtempSync(join(tmpdir(), "jaiph-claude-"));
    chmodSync(fallbackConfigDir, 0o700);
  } catch {
    return {
      env: execEnv,
      error:
        `jaiph: Claude backend could not initialize writable session state. ` +
        `Set CLAUDE_CONFIG_DIR to a writable directory and retry.`,
    };
  }

  try {
    // Seed only the auth/settings files (no `projects/` or other directories) so
    // the Claude CLI keeps its credentials when only session-env was unwritable.
    if (configuredDir && configuredDir !== fallbackConfigDir && existsSync(configuredDir)) {
      seedClaudeConfig(configuredDir, fallbackConfigDir);
    }
    const fallbackSessionDir = join(fallbackConfigDir, "session-env");
    mkdirSync(fallbackSessionDir, { recursive: true });
    if (!isDirWritable(fallbackSessionDir)) {
      return {
        env: execEnv,
        cleanupDir: fallbackConfigDir,
        error:
          `jaiph: Claude backend requires writable session state, but cannot write ` +
          `'${fallbackSessionDir}'. Fix permissions or set CLAUDE_CONFIG_DIR to a writable path.`,
      };
    }
    return {
      env: { ...execEnv, CLAUDE_CONFIG_DIR: fallbackConfigDir },
      cleanupDir: fallbackConfigDir,
      warning:
        `jaiph: Claude config dir '${configuredDir || "<unset>"}' is not writable; ` +
        `using ephemeral fallback '${fallbackConfigDir}'.`,
    };
  } catch {
    return {
      env: execEnv,
      cleanupDir: fallbackConfigDir,
      error:
        `jaiph: Claude backend could not initialize writable session state. ` +
        `Set CLAUDE_CONFIG_DIR to a writable directory and retry.`,
    };
  }
}
