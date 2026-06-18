import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Git working-tree state used to shape the inplace-mode warning copy.
 *  - "clean":   git repo, no uncommitted changes — run is reversible via git.
 *  - "dirty":   git repo, has uncommitted changes — run's edits will mix with them.
 *  - "no-repo": no git on PATH, or workspace is not a git repo — no safety net.
 */
export type GitTreeState = "clean" | "dirty" | "no-repo";

/**
 * Probe the workspace's git state without ever throwing.
 *
 * Treats every failure mode the same as "no-repo": `git` missing on PATH, the
 * directory not being a git repo, permission errors, etc. The user-facing
 * warning collapses those into a single "no safety net" branch on purpose.
 */
export function detectGitTreeState(workspaceRoot: string): GitTreeState {
  try {
    const inside = spawnSync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: workspaceRoot, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    );
    if (inside.status !== 0 || inside.stdout.trim() !== "true") return "no-repo";
    const status = spawnSync(
      "git",
      ["status", "--porcelain"],
      { cwd: workspaceRoot, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    );
    if (status.status !== 0) return "no-repo";
    return status.stdout.length === 0 ? "clean" : "dirty";
  } catch {
    return "no-repo";
  }
}

/**
 * The three required warning variants. Each names the actual workspace
 * directory and states a recovery posture concrete enough that a developer
 * who is about to lose work can reason about it.
 */
export function formatInplaceWarning(workspaceRoot: string, state: GitTreeState): string {
  const head =
    `⚠️  jaiph in-place mode: the workflow will edit files directly in ${workspaceRoot} on your machine.`;
  const tail = `Everything outside this directory stays sandboxed — the run can't touch the rest of your machine.`;
  let middle: string;
  if (state === "clean") {
    middle =
      `Your git tree is clean, so anything this run changes can be undone with \`git restore .\` (or \`git reset --hard\`).`;
  } else if (state === "dirty") {
    middle =
      `You have uncommitted changes — the run's edits will be mixed in with them and can't be cleanly undone. Consider committing or stashing first.`;
  } else {
    middle =
      `No git repository found here, so there's no safety net — these changes are irreversible. Consider \`git init\` and committing first.`;
  }
  return `${head}\n${middle}\n${tail}\n`;
}

/**
 * Minimal readline yes/no prompt. Defaults to "no" on empty input, EOF, or any
 * answer that does not start with `y`/`Y`. There is no existing helper in the
 * codebase; this is intentionally tiny rather than a new abstraction.
 */
async function defaultPromptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolveAnswer) => {
      rl.question(question, (input) => resolveAnswer(input));
      rl.once("close", () => resolveAnswer(""));
    });
    const trimmed = answer.trim().toLowerCase();
    return trimmed === "y" || trimmed === "yes";
  } finally {
    rl.close();
  }
}

/** Test seam: tests replace these to assert call/no-call and supply answers. */
export const _inplacePrompt = {
  ask: defaultPromptYesNo,
};

/**
 * Orchestrate the inplace warning + confirmation flow.
 *
 * - `JAIPH_INPLACE_YES=1` / `"true"` skips the prompt entirely (CI path).
 * - Non-TTY without the flag throws `E_DOCKER_INPLACE_NO_CONFIRM`.
 * - TTY: print the warning + a `Continue? [y/N]` prompt and return the answer.
 *
 * Returns true to proceed with the container launch, false to abort cleanly.
 */
export async function confirmInplaceRun(
  workspaceRoot: string,
  env: Record<string, string | undefined>,
  isTTY: boolean,
): Promise<boolean> {
  if (env.JAIPH_INPLACE_YES === "1" || env.JAIPH_INPLACE_YES === "true") {
    return true;
  }
  if (!isTTY) {
    throw new Error(
      "E_DOCKER_INPLACE_NO_CONFIRM jaiph in-place mode requires interactive confirmation, " +
        "but stdin is not a TTY. Set JAIPH_INPLACE_YES=1 to auto-confirm.",
    );
  }
  const state = detectGitTreeState(workspaceRoot);
  const warning = formatInplaceWarning(workspaceRoot, state);
  process.stderr.write(warning);
  return _inplacePrompt.ask("Continue? [y/N] ");
}
