import { createHash } from "node:crypto";

/**
 * Deterministic name for an inline script artifact.
 * Same body + shebang always produces the same name.
 */
export function inlineScriptName(body: string, shebang?: string): string {
  const key = shebang ? `${shebang}\n${body}` : body;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `__inline_${hash}`;
}
