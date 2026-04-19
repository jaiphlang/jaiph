import test from "node:test";
import assert from "node:assert/strict";
import {
  lookupKind,
  validateRef,
  WORKFLOW_REF_EXPECT,
  RUN_TARGET_REF_EXPECT,
  BARE_SEND_REF_MSG,
  type RefResolutionContext,
} from "./validate-ref-resolution";
import type { jaiphModule } from "../types";

function minimalModule(overrides?: Partial<jaiphModule>): jaiphModule {
  return {
    filePath: "test.jh",
    imports: [],
    channels: [],
    exports: [],
    scripts: [],
    workflows: [],
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<RefResolutionContext>): RefResolutionContext {
  return {
    importsByAlias: new Map(),
    importedAstCache: new Map(),
    localWorkflows: new Set(),
    localScripts: new Set(),
    ...overrides,
  };
}

function ref(value: string) {
  return { value, loc: { line: 1, col: 1 } };
}

// --- lookupKind ---

test("lookupKind: finds workflow", () => {
  const mod = minimalModule({
    workflows: [{ name: "deploy", comments: [], params: [], steps: [], loc: { line: 1, col: 1 } }],
  });
  assert.equal(lookupKind(mod, "deploy"), "workflow");
});

test("lookupKind: finds script", () => {
  const mod = minimalModule({
    scripts: [{ name: "build_it", comments: [], body: "", bodyKind: "backtick" as const, loc: { line: 1, col: 1 } }],
  });
  assert.equal(lookupKind(mod, "build_it"), "script");
});

test("lookupKind: returns undefined for missing symbol", () => {
  assert.equal(lookupKind(minimalModule(), "missing"), undefined);
});

// --- validateRef: expect mode (WORKFLOW_REF_EXPECT) ---

test("validateRef: accepts local workflow with WORKFLOW_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localWorkflows: new Set(["deploy"]) });
  validateRef(ref("deploy"), mod, ctx, { mode: "expect", expect: WORKFLOW_REF_EXPECT });
});

// --- validateRef: imported references ---

test("validateRef: accepts imported workflow with WORKFLOW_REF_EXPECT", () => {
  const importedMod = minimalModule({
    filePath: "lib.jh",
    workflows: [{ name: "deploy", comments: [], params: [], steps: [], loc: { line: 1, col: 1 } }],
  });
  const mod = minimalModule();
  const ctx = makeCtx({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    importedAstCache: new Map([["lib.jh", importedMod]]),
  });
  validateRef(ref("lib.deploy"), mod, ctx, { mode: "expect", expect: WORKFLOW_REF_EXPECT });
});

test("validateRef: rejects unknown import alias", () => {
  const mod = minimalModule();
  const ctx = makeCtx();
  assert.throws(
    () => validateRef(ref("unknown.thing"), mod, ctx, { mode: "expect", expect: WORKFLOW_REF_EXPECT }),
    /unknown import alias "unknown"/,
  );
});

test("validateRef: rejects missing imported symbol", () => {
  const importedMod = minimalModule({ filePath: "lib.jh" });
  const mod = minimalModule();
  const ctx = makeCtx({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    importedAstCache: new Map([["lib.jh", importedMod]]),
  });
  assert.throws(
    () => validateRef(ref("lib.missing"), mod, ctx, { mode: "expect", expect: WORKFLOW_REF_EXPECT }),
    /imported workflow "lib.missing" does not exist/,
  );
});

test("validateRef: rejects wrong kind for imported symbol", () => {
  const importedMod = minimalModule({
    filePath: "lib.jh",
    scripts: [{ name: "build", comments: [], body: "", bodyKind: "backtick" as const, loc: { line: 1, col: 1 } }],
  });
  const mod = minimalModule();
  const ctx = makeCtx({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    importedAstCache: new Map([["lib.jh", importedMod]]),
  });
  assert.throws(
    () => validateRef(ref("lib.build"), mod, ctx, { mode: "expect", expect: WORKFLOW_REF_EXPECT }),
    /script "lib.build" cannot be called with run/,
  );
});

test("validateRef: rejects three-part reference", () => {
  const mod = minimalModule();
  const ctx = makeCtx();
  assert.throws(
    () => validateRef(ref("a.b.c"), mod, ctx, { mode: "expect", expect: WORKFLOW_REF_EXPECT }),
    /invalid workflow reference "a.b.c"/,
  );
});

// --- validateRef: RUN_TARGET_REF_EXPECT (allows workflow or script) ---

test("validateRef: accepts local workflow with RUN_TARGET_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localWorkflows: new Set(["deploy"]) });
  validateRef(ref("deploy"), mod, ctx, { mode: "expect", expect: RUN_TARGET_REF_EXPECT });
});

test("validateRef: accepts local script with RUN_TARGET_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localScripts: new Set(["build"]) });
  validateRef(ref("build"), mod, ctx, { mode: "expect", expect: RUN_TARGET_REF_EXPECT });
});

// --- validateRef: bare_send_rhs mode ---

test("validateRef: bare_send_rhs rejects local workflow", () => {
  const mod = minimalModule({
    workflows: [{ name: "deploy", comments: [], params: [], steps: [], loc: { line: 1, col: 1 } }],
  });
  const ctx = makeCtx();
  assert.throws(
    () =>
      validateRef(ref("deploy"), mod, ctx, {
        mode: "bare_send_rhs",
        bareSend: BARE_SEND_REF_MSG,
        lookupImportedKind: () => undefined,
      }),
    /workflow "deploy" must be called with run/,
  );
});

test("validateRef: bare_send_rhs rejects local script", () => {
  const mod = minimalModule({
    scripts: [{ name: "build", comments: [], body: "", bodyKind: "backtick" as const, loc: { line: 1, col: 1 } }],
  });
  const ctx = makeCtx();
  assert.throws(
    () =>
      validateRef(ref("build"), mod, ctx, {
        mode: "bare_send_rhs",
        bareSend: BARE_SEND_REF_MSG,
        lookupImportedKind: () => undefined,
      }),
    /script "build" must be called with run/,
  );
});

test("validateRef: bare_send_rhs rejects unknown local", () => {
  const mod = minimalModule();
  const ctx = makeCtx();
  assert.throws(
    () =>
      validateRef(ref("missing"), mod, ctx, {
        mode: "bare_send_rhs",
        bareSend: BARE_SEND_REF_MSG,
        lookupImportedKind: () => undefined,
      }),
    /unknown symbol "missing" in send right-hand side/,
  );
});

test("validateRef: bare_send_rhs rejects imported workflow", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ importsByAlias: new Map([["lib", "lib.jh"]]) });
  assert.throws(
    () =>
      validateRef(ref("lib.deploy"), mod, ctx, {
        mode: "bare_send_rhs",
        bareSend: BARE_SEND_REF_MSG,
        lookupImportedKind: () => "workflow",
      }),
    /workflow "lib.deploy" must be called with run/,
  );
});

test("validateRef: bare_send_rhs rejects unknown import alias", () => {
  const mod = minimalModule();
  const ctx = makeCtx();
  assert.throws(
    () =>
      validateRef(ref("bad.thing"), mod, ctx, {
        mode: "bare_send_rhs",
        bareSend: BARE_SEND_REF_MSG,
        lookupImportedKind: () => undefined,
      }),
    /unknown import alias "bad"/,
  );
});

// --- export visibility ---

test("validateRef: rejects reference to non-exported symbol in module with exports", () => {
  const importedMod = minimalModule({
    filePath: "lib.jh",
    exports: ["public_wf"],
    workflows: [
      { name: "public_wf", comments: [], params: [], steps: [], loc: { line: 1, col: 1 } },
      { name: "private_wf", comments: [], params: [], steps: [], loc: { line: 2, col: 1 } },
    ],
  });
  const mod = minimalModule();
  const ctx = makeCtx({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    importedAstCache: new Map([["lib.jh", importedMod]]),
  });
  assert.throws(
    () => validateRef(ref("lib.private_wf"), mod, ctx, { mode: "expect", expect: WORKFLOW_REF_EXPECT }),
    /"private_wf" is not exported from module "lib"/,
  );
});

test("validateRef: accepts reference to exported symbol in module with exports", () => {
  const importedMod = minimalModule({
    filePath: "lib.jh",
    exports: ["public_wf"],
    workflows: [
      { name: "public_wf", comments: [], params: [], steps: [], loc: { line: 1, col: 1 } },
      { name: "private_wf", comments: [], params: [], steps: [], loc: { line: 2, col: 1 } },
    ],
  });
  const mod = minimalModule();
  const ctx = makeCtx({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    importedAstCache: new Map([["lib.jh", importedMod]]),
  });
  validateRef(ref("lib.public_wf"), mod, ctx, { mode: "expect", expect: WORKFLOW_REF_EXPECT });
});

test("validateRef: module with zero exports allows all references (legacy)", () => {
  const importedMod = minimalModule({
    filePath: "lib.jh",
    exports: [],
    workflows: [
      { name: "any_wf", comments: [], params: [], steps: [], loc: { line: 1, col: 1 } },
    ],
  });
  const mod = minimalModule();
  const ctx = makeCtx({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    importedAstCache: new Map([["lib.jh", importedMod]]),
  });
  validateRef(ref("lib.any_wf"), mod, ctx, { mode: "expect", expect: WORKFLOW_REF_EXPECT });
});

test("validateRef: bare_send_rhs rejects non-exported symbol before kind check", () => {
  const importedMod = minimalModule({
    filePath: "lib.jh",
    exports: ["exported_wf"],
    workflows: [
      { name: "exported_wf", comments: [], params: [], steps: [], loc: { line: 1, col: 1 } },
      { name: "private_wf", comments: [], params: [], steps: [], loc: { line: 2, col: 1 } },
    ],
  });
  const mod = minimalModule();
  const ctx = makeCtx({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    importedAstCache: new Map([["lib.jh", importedMod]]),
  });
  assert.throws(
    () =>
      validateRef(ref("lib.private_wf"), mod, ctx, {
        mode: "bare_send_rhs",
        bareSend: BARE_SEND_REF_MSG,
        lookupImportedKind: () => "workflow",
      }),
    /"private_wf" is not exported from module "lib"/,
  );
});
