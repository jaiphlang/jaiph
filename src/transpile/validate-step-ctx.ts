import type { Diagnostics } from "../diagnostics";
import type { jaiphModule, StepDef } from "../types";
import {
  RUN_TARGET_REF_EXPECT,
  type RefExpectMessages,
  type RefResolutionContext,
} from "./validate-ref-resolution";

// Shared validator context + scope tables. Kept in a dependency-free-ish leaf so
// the step dispatcher (`validate-step.ts`), the expression validators
// (`validate-expr.ts`), and the shared helpers (`validate-step-helpers.ts`) can
// all reference these shapes without an import cycle.

export interface Scope {
  kind: "def";
  /** Step types allowed in this scope — single set-lookup gate at the visitor entry. */
  allowSteps: Set<StepDef["type"]>;
  /** Per-step-type message used when a step is rejected by `allowSteps`. */
  disallowStepMessages: Partial<Record<StepDef["type"], string>>;
  /** Ref expectation for `run ref(...)` callees. */
  runRefExpect: RefExpectMessages;
  /** Collect typed prompt schemas from `const x = prompt … returns`. */
  withPromptSchemas: boolean;
}

export const DEF_SCOPE: Scope = {
  kind: "def",
  allowSteps: new Set([
    "trivia",
    "send",
    "say",
    "return",
    "const",
    "exec",
    "if",
    "for_lines",
  ]),
  disallowStepMessages: {},
  runRefExpect: RUN_TARGET_REF_EXPECT,
  withPromptSchemas: true,
};

export interface ValidatorCtx {
  diag: Diagnostics;
  ast: jaiphModule;
  refCtx: RefResolutionContext;
  scope: Scope;
  knownVars: Set<string>;
  promptSchemas: Map<string, string[]>;
  /** All variables bound via `const x = prompt …` or `exec` with a prompt body capture — typed and untyped. */
  promptCaptures: Set<string>;
  recoverBindings: Set<string> | undefined;
  localChannels: Set<string>;
  localScripts: Set<string>;
  localDefs: Set<string>;
  importsByAlias: Map<string, string>;
  importedAstCache: Map<string, jaiphModule>;
}

/** Which step introduced an expression — selects the string-content rules. */
export type ExprLabel = "const" | "return" | "send" | "exec";
