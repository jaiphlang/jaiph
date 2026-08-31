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

/**
 * Deterministic emitted-file name for a nested (def-local) `script`. The name is
 * a pure function of the declaration (its name, body, fence lang, and `use`
 * keys), so the emitter and the runtime compute the same file name without a
 * shared side channel, and two identical nested scripts dedupe to one file. The
 * hashed name keeps a nested `script foo` from colliding with a module-level
 * `script foo` it shadows (that one emits under its bare name `foo`).
 */
export function nestedScriptName(
  name: string,
  body: string,
  lang?: string,
  use?: string[],
): string {
  const key = [name, lang ?? "", (use ?? []).join(","), body].join("\0");
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `__nested_${hash}`;
}
