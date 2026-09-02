import type { Def, LocalDecl, PromptDef } from "../types";
import type { RefResolutionContext } from "./validate-ref-resolution";

// Helpers for validating nested (def-local) declarations: naming, the resolved
// symbol shape, and overlaying the locals visible at a step onto the module ref
// context. Split out of `validate.ts` to keep it under the analyzability line
// cap; the recursive block-scoped driver (`validateDef`) lives in
// `validate-def-scope.ts` and consumes these helpers.

/**
 * A nested declaration in lexical scope, resolved for ref lookups. Scripts carry
 * no params/returns, so only the symbol kind is tracked for them.
 */
export type LocalSym =
  | { kind: "script" }
  | { kind: "def"; def: Def }
  | { kind: "prompt"; prompt: PromptDef };

export function localDeclName(decl: LocalDecl): string {
  if (decl.kind === "script") return decl.script.name;
  if (decl.kind === "def") return decl.def.name;
  return decl.prompt.name;
}

export function localSymFromDecl(decl: LocalDecl): LocalSym {
  if (decl.kind === "def") return { kind: "def", def: decl.def };
  if (decl.kind === "prompt") return { kind: "prompt", prompt: decl.prompt };
  return { kind: "script" };
}

/**
 * Overlay the nested declarations visible at a step onto the module ref context
 * so `run` / `prompt` targets resolve to a local first (shadowing a module
 * symbol of the same or different kind).
 */
export function refCtxWithLocals(
  base: RefResolutionContext,
  locals: Map<string, LocalSym>,
): RefResolutionContext {
  if (locals.size === 0) return base;
  const localDefs = new Set(base.localDefs);
  const localScripts = new Set(base.localScripts);
  const localPrompts = new Set(base.localPrompts ?? []);
  const localDefsByName = new Map<string, Def>();
  const localPromptsByName = new Map<string, PromptDef>();
  for (const [name, sym] of locals) {
    localDefs.delete(name);
    localScripts.delete(name);
    localPrompts.delete(name);
    if (sym.kind === "def") {
      localDefs.add(name);
      localDefsByName.set(name, sym.def);
    } else if (sym.kind === "prompt") {
      localPrompts.add(name);
      localPromptsByName.set(name, sym.prompt);
    } else {
      localScripts.add(name);
    }
  }
  return { ...base, localDefs, localScripts, localPrompts, localDefsByName, localPromptsByName };
}
