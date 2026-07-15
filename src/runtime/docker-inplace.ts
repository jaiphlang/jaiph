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
 * Shared git-state recovery paragraph. Both the in-place and unsafe warnings
 * use the identical three variants so the "can I undo this?" guidance stays in
 * one place (and stays consistent) rather than drifting between the two modes.
 */
function gitStateParagraph(state: GitTreeState): string {
  if (state === "clean") {
    return `Your git tree is clean, so anything this run changes can be undone with \`git restore .\` (or \`git reset --hard\`).`;
  }
  if (state === "dirty") {
    return `You have uncommitted changes — the run's edits will be mixed in with them and can't be cleanly undone. Consider committing or stashing first.`;
  }
  return `No git repository found here, so there's no safety net — these changes are irreversible. Consider \`git init\` and committing first.`;
}

/**
 * In-place warning. Leads (right after the header) with the access scope in
 * plain language — edits land only in this workspace directory, and the rest
 * of the machine stays inside the Docker sandbox — then the git-state recovery
 * paragraph, then the sandbox-boundary reminder. Each variant names the actual
 * workspace directory so a developer about to lose work can reason about it.
 */
export function formatInplaceWarning(workspaceRoot: string, state: GitTreeState): string {
  const head =
    `⚠️  jaiph in-place mode: the workflow will edit files directly in ${workspaceRoot} on your machine.`;
  const scope =
    `Filesystem access: this workspace directory only (${workspaceRoot}). The rest of your machine stays inside the Docker sandbox.`;
  const tail = `Everything outside this directory stays sandboxed — the run can't touch the rest of your machine.`;
  return `${head}\n${scope}\n${gitStateParagraph(state)}\n${tail}\n`;
}

/**
 * Unsafe warning. Deliberately stronger than the in-place copy: unsafe mode is
 * strictly more exposure, not a lighter variant. Leads with host-only / no
 * sandbox, then states that filesystem access is the entire machine and that
 * scripts and agent backends can read secrets from the environment and reach
 * paths outside the project, then the shared git-state recovery paragraph.
 */
export function formatUnsafeWarning(workspaceRoot: string, state: GitTreeState): string {
  const head =
    `☢️  jaiph unsafe mode: the workflow runs directly on your host with NO sandbox (Docker is off).`;
  const scope =
    `Filesystem access: your ENTIRE machine — not just ${workspaceRoot}. Scripts and agent backends can read and write any path your user can, reach outside this project, and read secrets from your environment (SSH keys, cloud credentials, tokens, Keychain).`;
  const tail =
    `This is strictly more exposure than --inplace. Only continue if you fully trust this workflow and every agent it launches.`;
  return `${head}\n${scope}\n${gitStateParagraph(state)}\n${tail}\n`;
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

/**
 * Test seam: tests replace this to assert call/no-call and supply answers.
 * Shared by both `confirmInplaceRun` and `confirmUnsafeRun` — one yes/no prompt.
 */
export const _inplacePrompt = {
  ask: defaultPromptYesNo,
};

/**
 * Auto-confirm gate shared by both in-place and unsafe modes. `--yes` /
 * `JAIPH_INPLACE_YES` is the single, documented auto-confirm story: it skips
 * the confirmation prompt for either mode (used by CI / non-interactive runs).
 */
function isAutoConfirmed(env: Record<string, string | undefined>): boolean {
  return env.JAIPH_INPLACE_YES === "1" || env.JAIPH_INPLACE_YES === "true";
}

/**
 * Orchestrate the inplace warning + confirmation flow.
 *
 * - `JAIPH_INPLACE_YES=1` / `"true"` (or `--yes`) skips the prompt (CI path).
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
  if (isAutoConfirmed(env)) {
    return true;
  }
  if (!isTTY) {
    throw new Error(
      "E_DOCKER_INPLACE_NO_CONFIRM jaiph in-place mode requires interactive confirmation, " +
        "but stdin is not a TTY. Set JAIPH_INPLACE_YES=1 (or pass --yes) to auto-confirm.",
    );
  }
  const state = detectGitTreeState(workspaceRoot);
  const warning = formatInplaceWarning(workspaceRoot, state);
  process.stderr.write(warning);
  return _inplacePrompt.ask("Continue? [y/N] ");
}

/**
 * Orchestrate the unsafe (host-only, no sandbox) warning + confirmation flow.
 * Mirrors `confirmInplaceRun`'s UX exactly, with a scarier warning and its own
 * error code so the two modes stay distinguishable in logs and messages.
 *
 * - `JAIPH_INPLACE_YES=1` / `"true"` (or `--yes`) skips the prompt (CI path).
 * - Non-TTY without the flag throws `E_UNSAFE_NO_CONFIRM`.
 * - TTY: print the warning + a `Continue? [y/N]` prompt and return the answer.
 *
 * Returns true to proceed with the host-only run, false to abort cleanly.
 */
export async function confirmUnsafeRun(
  workspaceRoot: string,
  env: Record<string, string | undefined>,
  isTTY: boolean,
): Promise<boolean> {
  if (isAutoConfirmed(env)) {
    return true;
  }
  if (!isTTY) {
    throw new Error(
      "E_UNSAFE_NO_CONFIRM jaiph unsafe mode (host-only, no sandbox) requires interactive confirmation, " +
        "but stdin is not a TTY. Set JAIPH_INPLACE_YES=1 (or pass --yes) to auto-confirm.",
    );
  }
  const state = detectGitTreeState(workspaceRoot);
  const warning = formatUnsafeWarning(workspaceRoot, state);
  process.stderr.write(warning);
  return _inplacePrompt.ask("Continue? [y/N] ");
}
