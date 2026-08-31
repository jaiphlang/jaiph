import { jaiphError } from "../errors";
import type { Def, jaiphModule, PromptDef } from "../types";

export type RefTargetKind = "def" | "script" | "prompt";

/** Look up which kind a name belongs to in a module. */
export function lookupKind(mod: jaiphModule, name: string): RefTargetKind | undefined {
  if (mod.defs.some((w) => w.name === name)) return "def";
  if (mod.scripts.some((s) => s.name === name)) return "script";
  if (mod.prompts?.some((p) => p.name === name)) return "prompt";
  return undefined;
}

export interface RefResolutionContext {
  importsByAlias: Map<string, string>;
  importedAstCache: Map<string, jaiphModule>;
  localDefs: Set<string>;
  localScripts: Set<string>;
  /** Named prompts in the current module (absent in narrow test contexts). */
  localPrompts?: Set<string>;
  /**
   * Nested `def` / named `prompt` declarations in lexical scope (enclosing def).
   * Populated per-step so arity / returns lookups resolve a nested target the
   * same way as a module-level one. Nested names win over module names.
   */
  localDefsByName?: Map<string, Def>;
  localPromptsByName?: Map<string, PromptDef>;
}

function localSymbolKind(
  name: string,
  ctx: RefResolutionContext,
): RefTargetKind | undefined {
  if (ctx.localDefs.has(name)) return "def";
  if (ctx.localScripts.has(name)) return "script";
  if (ctx.localPrompts?.has(name)) return "prompt";
  return undefined;
}

function importedHasAllowedKind(
  mod: jaiphModule,
  name: string,
  allowed: Set<RefTargetKind>,
): boolean {
  if (allowed.has("def") && mod.defs.some((w) => w.name === name)) return true;
  if (allowed.has("script") && mod.scripts.some((s) => s.name === name)) return true;
  if (allowed.has("prompt") && (mod.prompts?.some((p) => p.name === name) ?? false)) return true;
  return false;
}

function isExported(mod: jaiphModule, name: string): boolean {
  return mod.exports.includes(name);
}

export interface RefExpectMessages {
  allowedKinds: Set<RefTargetKind>;
  invalidSplitRef: (refValue: string) => string;
  unknownImportAlias: (alias: string, refValue: string) => string;
  unknownLocal: (refValue: string) => string;
  missingImported: (refValue: string) => string;
  wrongLocal: Partial<Record<RefTargetKind, (shortName: string, refValue: string) => string>>;
  wrongImported: Partial<Record<RefTargetKind, (refValue: string) => string>>;
}

export interface BareSendRefMessages {
  unknownImportAlias: (alias: string, refValue: string) => string;
  unknownLocal: (refValue: string) => string;
  wrongDefLocal: (refValue: string) => string;
  wrongScriptLocal: (refValue: string) => string;
  wrongDefImported: (refValue: string) => string;
  wrongScriptImported: (refValue: string) => string;
  unknownSymbolImported: (refValue: string) => string;
}

export type RefValidationSpec =
  | { mode: "expect"; expect: RefExpectMessages }
  | {
      mode: "bare_send_rhs";
      bareSend: BareSendRefMessages;
      lookupImportedKind: (alias: string, name: string) => RefTargetKind | undefined;
    };

function throwWrongLocal(
  filePath: string,
  line: number,
  col: number,
  wrongLocal: RefExpectMessages["wrongLocal"],
  k: RefTargetKind,
  shortName: string,
  refValue: string,
): never {
  const fn = wrongLocal[k];
  if (!fn) {
    throw new Error(`validateRef: missing wrongLocal message for kind "${k}"`);
  }
  throw jaiphError(filePath, line, col, "E_VALIDATE", fn(shortName, refValue));
}

function throwWrongImported(
  filePath: string,
  line: number,
  col: number,
  wrongImported: RefExpectMessages["wrongImported"],
  k: RefTargetKind,
  refValue: string,
): never {
  const fn = wrongImported[k];
  if (!fn) {
    throw new Error(`validateRef: missing wrongImported message for kind "${k}"`);
  }
  throw jaiphError(filePath, line, col, "E_VALIDATE", fn(refValue));
}

function throwIfNotExported(
  fp: string,
  line: number,
  col: number,
  importedAst: jaiphModule,
  importedName: string,
  alias: string,
): void {
  if (lookupKind(importedAst, importedName) === undefined) return;
  if (!isExported(importedAst, importedName)) {
    throw jaiphError(fp, line, col, "E_VALIDATE",
      `"${importedName}" is not exported from module "${alias}"`);
  }
}

/**
 * Validates a reference: either it must resolve to one of the allowed kinds (expect mode),
 * or it must not resolve to workflow/script (bare send RHS mode).
 * Imported names are private unless listed in the module's exports.
 */
export function validateRef(
  ref: { value: string; loc: { line: number; col: number } },
  mod: jaiphModule,
  ctx: RefResolutionContext,
  spec: RefValidationSpec,
): void {
  const parts = ref.value.split(".");
  const { line, col } = ref.loc;
  const fp = mod.filePath;

  if (spec.mode === "bare_send_rhs") {
    const msg = spec.bareSend;
    if (parts.length === 1) {
      const name = parts[0];
      const kind = lookupKind(mod, name);
      if (kind === "def") {
        throw jaiphError(fp, line, col, "E_VALIDATE", msg.wrongDefLocal(ref.value));
      }
      if (kind === "script") {
        throw jaiphError(fp, line, col, "E_VALIDATE", msg.wrongScriptLocal(ref.value));
      }
      throw jaiphError(fp, line, col, "E_VALIDATE", msg.unknownLocal(ref.value));
    }
    const [alias, importedName] = parts;
    if (!ctx.importsByAlias.has(alias)) {
      throw jaiphError(fp, line, col, "E_VALIDATE", msg.unknownImportAlias(alias, ref.value));
    }
    const importedFileBare = ctx.importsByAlias.get(alias)!;
    const importedAstBare = ctx.importedAstCache.get(importedFileBare);
    if (importedAstBare) {
      throwIfNotExported(fp, line, col, importedAstBare, importedName, alias);
    }
    const ik = spec.lookupImportedKind(alias, importedName);
    if (ik === "def") {
      throw jaiphError(fp, line, col, "E_VALIDATE", msg.wrongDefImported(ref.value));
    }
    if (ik === "script") {
      throw jaiphError(fp, line, col, "E_VALIDATE", msg.wrongScriptImported(ref.value));
    }
    throw jaiphError(fp, line, col, "E_VALIDATE", msg.unknownSymbolImported(ref.value));
  }

  const expectSpec = spec.expect;
  if (parts.length === 1) {
    const name = parts[0];
    const k = localSymbolKind(name, ctx);
    if (k && expectSpec.allowedKinds.has(k)) return;
    if (k) throwWrongLocal(fp, line, col, expectSpec.wrongLocal, k, name, ref.value);
    throw jaiphError(fp, line, col, "E_VALIDATE", expectSpec.unknownLocal(ref.value));
  }

  if (parts.length !== 2) {
    throw jaiphError(fp, line, col, "E_VALIDATE", expectSpec.invalidSplitRef(ref.value));
  }

  const [alias, importedName] = parts;
  const importedFile = ctx.importsByAlias.get(alias);
  if (!importedFile) {
    throw jaiphError(fp, line, col, "E_VALIDATE", expectSpec.unknownImportAlias(alias, ref.value));
  }
  const importedAst = ctx.importedAstCache.get(importedFile)!;

  throwIfNotExported(fp, line, col, importedAst, importedName, alias);

  if (importedHasAllowedKind(importedAst, importedName, expectSpec.allowedKinds)) return;

  const ik = lookupKind(importedAst, importedName);
  if (ik) throwWrongImported(fp, line, col, expectSpec.wrongImported, ik, ref.value);
  throw jaiphError(fp, line, col, "E_VALIDATE", expectSpec.missingImported(ref.value));
}

export const DEF_REF_EXPECT: RefExpectMessages = {
  allowedKinds: new Set<RefTargetKind>(["def"]),
  invalidSplitRef: (rv) => `invalid def reference "${rv}"`,
  unknownImportAlias: (alias, rv) => `unknown import alias "${alias}" for def reference "${rv}"`,
  unknownLocal: (rv) => `unknown local def reference "${rv}"`,
  missingImported: (rv) => `imported def "${rv}" does not exist`,
  wrongLocal: {
    script: (name) => `script "${name}" cannot be called with run`,
  },
  wrongImported: {
    script: (rv) => `script "${rv}" cannot be called with run`,
  },
};

export const RUN_TARGET_REF_EXPECT: RefExpectMessages = {
  allowedKinds: new Set<RefTargetKind>(["def", "script"]),
  invalidSplitRef: (rv) => `invalid run target reference "${rv}"`,
  unknownImportAlias: (alias, rv) => `unknown import alias "${alias}" for run target "${rv}"`,
  unknownLocal: (rv) => `unknown local def or script reference "${rv}"`,
  missingImported: (rv) => `imported def or script "${rv}" does not exist`,
  wrongLocal: {
    prompt: (name) => `prompt "${name}" cannot be called with run; invoke it with prompt ${name}(...)`,
  },
  wrongImported: {
    prompt: (rv) => `prompt "${rv}" cannot be called with run; invoke it with prompt ${rv}(...)`,
  },
};

/** Expect messages for a named-prompt invocation `prompt name(...)`. */
export const PROMPT_REF_EXPECT: RefExpectMessages = {
  allowedKinds: new Set<RefTargetKind>(["prompt"]),
  invalidSplitRef: (rv) => `invalid prompt reference "${rv}"`,
  unknownImportAlias: (alias, rv) => `unknown import alias "${alias}" for prompt reference "${rv}"`,
  unknownLocal: (rv) => `unknown local prompt reference "${rv}"`,
  missingImported: (rv) => `imported prompt "${rv}" does not exist`,
  wrongLocal: {
    def: (name) => `"${name}" is a def, not a prompt; call it with run ${name}(...)`,
    script: (name) => `"${name}" is a script, not a prompt; call it with run ${name}(...)`,
  },
  wrongImported: {
    def: (rv) => `"${rv}" is a def, not a prompt; call it with run ${rv}(...)`,
    script: (rv) => `"${rv}" is a script, not a prompt; call it with run ${rv}(...)`,
  },
};

export const BARE_SEND_REF_MSG: BareSendRefMessages = {
  unknownImportAlias: (alias, rv) => `unknown import alias "${alias}" for send reference "${rv}"`,
  unknownLocal: (rv) => `unknown symbol "${rv}" in send right-hand side`,
  wrongDefLocal: (rv) => `def "${rv}" must be called with run`,
  wrongScriptLocal: (rv) => `script "${rv}" must be called with run`,
  wrongDefImported: (rv) => `def "${rv}" must be called with run`,
  wrongScriptImported: (rv) => `script "${rv}" must be called with run`,
  unknownSymbolImported: (rv) => `unknown symbol "${rv}" in send right-hand side`,
};
