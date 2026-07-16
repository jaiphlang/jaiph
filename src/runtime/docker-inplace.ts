import { createInterface } from "node:readline";

/** Runtime tree warning emitted at the start of every consented unsafe host-only run. */
export const UNSAFE_RUN_LOGWARN_MESSAGE =
  "You are running the Jaiph workflow in the unsafe mode with no sandboxing. It has full access to your machine.";

/**
 * In-place confirmation warning. States the access scope in plain language —
 * edits land only in this workspace directory, and the rest of the machine
 * stays inside the Docker sandbox.
 */
export function formatInplaceWarning(workspaceRoot: string): string {
  return (
    `⚠️ You are going to run the Jaiph workflow in the in-place mode:\n` +
    `  - It can edit files directly in ${workspaceRoot}\n` +
    `  - It has no access to other directories. The rest of your machine stays inside the Docker sandbox.\n\n`
  );
}

/** Unsafe confirmation warning — host-only, no sandbox, full machine access. */
export function formatUnsafeWarning(): string {
  return (
    `⚠️ You are going to run the Jaiph workflow in the unsafe mode with no sandboxing. It has full access to your machine.\n\n`
  );
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
  process.stderr.write(formatInplaceWarning(workspaceRoot));
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
  _workspaceRoot: string,
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
  process.stderr.write(formatUnsafeWarning());
  return _inplacePrompt.ask("Continue? [y/N] ");
}
