import test from "node:test";
import assert from "node:assert/strict";
import {
  lookupKind,
  validateRef,
  RULE_REF_EXPECT,
  WORKFLOW_REF_EXPECT,
  RUN_TARGET_REF_EXPECT,
  RUN_IN_RULE_REF_EXPECT,
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
    rules: [],
    scripts: [],
    workflows: [],
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<RefResolutionContext>): RefResolutionContext {
  return {
    importsByAlias: new Map(),
    importedAstCache: new Map(),
    localRules: new Set(),
    localWorkflows: new Set(),
    localScripts: new Set(),
    ...overrides,
  };
}

function ref(value: string) {
  return { value, loc: { line: 1, col: 1 } };
}

// --- lookupKind ---

test("lookupKind: finds rule", () => {
  const mod = minimalModule({
    rules: [{ name: "check", comments: [], steps: [], loc: { line: 1, col: 1 } }],
  });
  assert.equal(lookupKind(mod, "check"), "rule");
});

test("lookupKind: finds workflow", () => {
  const mod = minimalModule({
    workflows: [{ name: "deploy", comments: [], steps: [], loc: { line: 1, col: 1 } }],
  });
  assert.equal(lookupKind(mod, "deploy"), "workflow");
});

test("lookupKind: finds script", () => {
  const mod = minimalModule({
    scripts: [{ name: "build_it", comments: [], body: "", bodyKind: "string" as const, loc: { line: 1, col: 1 } }],
  });
  assert.equal(lookupKind(mod, "build_it"), "script");
});

test("lookupKind: returns undefined for missing symbol", () => {
  assert.equal(lookupKind(minimalModule(), "missing"), undefined);
});

// --- validateRef: expect mode (RULE_REF_EXPECT) ---

test("validateRef: accepts local rule with RULE_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localRules: new Set(["check"]) });
  validateRef(ref("check"), mod, ctx, { mode: "expect", expect: RULE_REF_EXPECT });
});

test("validateRef: rejects local workflow with RULE_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localWorkflows: new Set(["deploy"]) });
  assert.throws(
    () => validateRef(ref("deploy"), mod, ctx, { mode: "expect", expect: RULE_REF_EXPECT }),
    /workflow "deploy" must be called with run/,
  );
});

test("validateRef: rejects local script with RULE_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localScripts: new Set(["build"]) });
  assert.throws(
    () => validateRef(ref("build"), mod, ctx, { mode: "expect", expect: RULE_REF_EXPECT }),
    /script "build" cannot be called with ensure/,
  );
});

test("validateRef: rejects unknown local name with RULE_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx();
  assert.throws(
    () => validateRef(ref("missing"), mod, ctx, { mode: "expect", expect: RULE_REF_EXPECT }),
    /unknown local rule reference "missing"/,
  );
});

// --- validateRef: expect mode (WORKFLOW_REF_EXPECT) ---

test("validateRef: accepts local workflow with WORKFLOW_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localWorkflows: new Set(["deploy"]) });
  validateRef(ref("deploy"), mod, ctx, { mode: "expect", expect: WORKFLOW_REF_EXPECT });
});

test("validateRef: rejects local rule with WORKFLOW_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localRules: new Set(["check"]) });
  assert.throws(
    () => validateRef(ref("check"), mod, ctx, { mode: "expect", expect: WORKFLOW_REF_EXPECT }),
    /rule "check" must be called with ensure/,
  );
});

// --- validateRef: imported references ---

test("validateRef: accepts imported rule with RULE_REF_EXPECT", () => {
  const importedMod = minimalModule({
    filePath: "lib.jh",
    rules: [{ name: "ready", comments: [], steps: [], loc: { line: 1, col: 1 } }],
  });
  const mod = minimalModule();
  const ctx = makeCtx({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    importedAstCache: new Map([["lib.jh", importedMod]]),
  });
  validateRef(ref("lib.ready"), mod, ctx, { mode: "expect", expect: RULE_REF_EXPECT });
});

test("validateRef: rejects unknown import alias", () => {
  const mod = minimalModule();
  const ctx = makeCtx();
  assert.throws(
    () => validateRef(ref("unknown.thing"), mod, ctx, { mode: "expect", expect: RULE_REF_EXPECT }),
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
    () => validateRef(ref("lib.missing"), mod, ctx, { mode: "expect", expect: RULE_REF_EXPECT }),
    /imported rule "lib.missing" does not exist/,
  );
});

test("validateRef: rejects wrong kind for imported symbol", () => {
  const importedMod = minimalModule({
    filePath: "lib.jh",
    workflows: [{ name: "deploy", comments: [], steps: [], loc: { line: 1, col: 1 } }],
  });
  const mod = minimalModule();
  const ctx = makeCtx({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    importedAstCache: new Map([["lib.jh", importedMod]]),
  });
  assert.throws(
    () => validateRef(ref("lib.deploy"), mod, ctx, { mode: "expect", expect: RULE_REF_EXPECT }),
    /workflow "lib.deploy" must be called with run/,
  );
});

test("validateRef: rejects three-part reference", () => {
  const mod = minimalModule();
  const ctx = makeCtx();
  assert.throws(
    () => validateRef(ref("a.b.c"), mod, ctx, { mode: "expect", expect: RULE_REF_EXPECT }),
    /invalid rule reference "a.b.c"/,
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

test("validateRef: rejects local rule with RUN_TARGET_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localRules: new Set(["check"]) });
  assert.throws(
    () => validateRef(ref("check"), mod, ctx, { mode: "expect", expect: RUN_TARGET_REF_EXPECT }),
    /rule "check" must be called with ensure, not run/,
  );
});

// --- validateRef: RUN_IN_RULE_REF_EXPECT (only scripts) ---

test("validateRef: accepts local script with RUN_IN_RULE_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localScripts: new Set(["build"]) });
  validateRef(ref("build"), mod, ctx, { mode: "expect", expect: RUN_IN_RULE_REF_EXPECT });
});

test("validateRef: rejects local workflow with RUN_IN_RULE_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localWorkflows: new Set(["deploy"]) });
  assert.throws(
    () => validateRef(ref("deploy"), mod, ctx, { mode: "expect", expect: RUN_IN_RULE_REF_EXPECT }),
    /run inside a rule must target a script, not workflow "deploy"/,
  );
});

// --- validateRef: bare_send_rhs mode ---

test("validateRef: bare_send_rhs rejects local workflow", () => {
  const mod = minimalModule({
    workflows: [{ name: "deploy", comments: [], steps: [], loc: { line: 1, col: 1 } }],
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
    scripts: [{ name: "build", comments: [], body: "", bodyKind: "string" as const, loc: { line: 1, col: 1 } }],
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

test("validateRef: bare_send_rhs rejects local rule", () => {
  const mod = minimalModule({
    rules: [{ name: "check", comments: [], steps: [], loc: { line: 1, col: 1 } }],
  });
  const ctx = makeCtx();
  assert.throws(
    () =>
      validateRef(ref("check"), mod, ctx, {
        mode: "bare_send_rhs",
        bareSend: BARE_SEND_REF_MSG,
        lookupImportedKind: () => undefined,
      }),
    /rule "check" must be called with ensure/,
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
