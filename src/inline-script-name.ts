import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * Deterministic emitted-file name for a module-level `script` (a declared
 * `script name = …` or an `import script … as name`). The name is unique per
 * (module, script name): two modules that both declare `script check` emit to
 * distinct files, so one module's body can never overwrite another's, and a
 * script call always runs the body of the module it resolves to. The emitter
 * and the runtime both derive the name from the module's absolute path, so they
 * agree without a shared side channel. Inline (`__inline_*`) and nested
 * (`__nested_*`) scripts keep their content-hash names.
 */
export function moduleScriptFileName(modulePath: string, scriptName: string): string {
  const hash = createHash("sha256").update(resolve(modulePath)).digest("hex").slice(0, 12);
  return `${scriptName}__${hash}`;
}

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
