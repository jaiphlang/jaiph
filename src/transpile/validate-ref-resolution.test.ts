import test from "node:test";
import assert from "node:assert/strict";
import {
  lookupKind,
  validateRef,
  DEF_REF_EXPECT,
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
    defs: [],
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<RefResolutionContext>): RefResolutionContext {
  return {
    importsByAlias: new Map(),
    importedAstCache: new Map(),
    localDefs: new Set(),
    localScripts: new Set(),
    ...overrides,
  };
}

function ref(value: string) {
  return { value, loc: { line: 1, col: 1 } };
}

function wf(name: string) {
  return { name, comments: [] as string[], params: [] as string[], steps: [], loc: { line: 1, col: 1 } };
}

test("lookupKind: finds workflow", () => {
  const mod = minimalModule({ defs: [wf("deploy")] });
  assert.equal(lookupKind(mod, "deploy"), "def");
});

test("lookupKind: finds script", () => {
  const mod = minimalModule({
    scripts: [{ name: "build_it", comments: [], body: "", loc: { line: 1, col: 1 } }],
  });
  assert.equal(lookupKind(mod, "build_it"), "script");
});

test("lookupKind: returns undefined for missing symbol", () => {
  assert.equal(lookupKind(minimalModule(), "missing"), undefined);
});

test("validateRef: accepts local def with RUN_TARGET_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localDefs: new Set(["deploy"]) });
  validateRef(ref("deploy"), mod, ctx, { mode: "expect", expect: RUN_TARGET_REF_EXPECT });
});

test("validateRef: accepts local script with RUN_TARGET_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localScripts: new Set(["build"]) });
  validateRef(ref("build"), mod, ctx, { mode: "expect", expect: RUN_TARGET_REF_EXPECT });
});

test("validateRef: rejects unknown local name with RUN_TARGET_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx();
  assert.throws(
    () => validateRef(ref("missing"), mod, ctx, { mode: "expect", expect: RUN_TARGET_REF_EXPECT }),
    /unknown local def or script reference "missing"/,
  );
});

test("validateRef: accepts local def with DEF_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localDefs: new Set(["deploy"]) });
  validateRef(ref("deploy"), mod, ctx, { mode: "expect", expect: DEF_REF_EXPECT });
});

test("validateRef: rejects local script with DEF_REF_EXPECT", () => {
  const mod = minimalModule();
  const ctx = makeCtx({ localScripts: new Set(["build"]) });
  assert.throws(
    () => validateRef(ref("build"), mod, ctx, { mode: "expect", expect: DEF_REF_EXPECT }),
    /script "build" cannot be called with run/,
  );
});

test("validateRef: rejects unknown import alias", () => {
  const mod = minimalModule();
  const ctx = makeCtx();
  assert.throws(
    () => validateRef(ref("unknown.thing"), mod, ctx, { mode: "expect", expect: RUN_TARGET_REF_EXPECT }),
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
    () => validateRef(ref("lib.missing"), mod, ctx, { mode: "expect", expect: RUN_TARGET_REF_EXPECT }),
    /imported def or script "lib.missing" does not exist/,
  );
});

test("validateRef: rejects three-part reference", () => {
  const mod = minimalModule();
  const ctx = makeCtx();
  assert.throws(
    () => validateRef(ref("a.b.c"), mod, ctx, { mode: "expect", expect: RUN_TARGET_REF_EXPECT }),
    /invalid run target reference "a.b.c"/,
  );
});

test("validateRef: bare_send_rhs rejects local def", () => {
  const mod = minimalModule({ defs: [wf("deploy")] });
  const ctx = makeCtx();
  assert.throws(
    () =>
      validateRef(ref("deploy"), mod, ctx, {
        mode: "bare_send_rhs",
        bareSend: BARE_SEND_REF_MSG,
        lookupImportedKind: () => undefined,
      }),
    /def "deploy" must be called with run/,
  );
});

test("validateRef: bare_send_rhs rejects local script", () => {
  const mod = minimalModule({
    scripts: [{ name: "build", comments: [], body: "", loc: { line: 1, col: 1 } }],
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

test("validateRef: rejects reference to non-exported symbol", () => {
  const importedMod = minimalModule({
    filePath: "lib.jh",
    exports: ["public_def"],
    defs: [wf("public_def"), { ...wf("private_def"), loc: { line: 2, col: 1 } }],
  });
  importedMod.defs[1].name = "private_def";
  const mod = minimalModule();
  const ctx = makeCtx({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    importedAstCache: new Map([["lib.jh", importedMod]]),
  });
  assert.throws(
    () => validateRef(ref("lib.private_def"), mod, ctx, { mode: "expect", expect: RUN_TARGET_REF_EXPECT }),
    /"private_def" is not exported from module "lib"/,
  );
});

test("validateRef: accepts reference to exported symbol", () => {
  const importedMod = minimalModule({
    filePath: "lib.jh",
    exports: ["public_def"],
    defs: [wf("public_def"), { ...wf("private_def"), loc: { line: 2, col: 1 } }],
  });
  importedMod.defs[1].name = "private_def";
  const mod = minimalModule();
  const ctx = makeCtx({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    importedAstCache: new Map([["lib.jh", importedMod]]),
  });
  validateRef(ref("lib.public_def"), mod, ctx, { mode: "expect", expect: RUN_TARGET_REF_EXPECT });
});

test("validateRef: zero exports allows nothing (private by default)", () => {
  const importedMod = minimalModule({
    filePath: "lib.jh",
    exports: [],
    defs: [wf("any_def")],
  });
  const mod = minimalModule();
  const ctx = makeCtx({
    importsByAlias: new Map([["lib", "lib.jh"]]),
    importedAstCache: new Map([["lib.jh", importedMod]]),
  });
  assert.throws(
    () => validateRef(ref("lib.any_def"), mod, ctx, { mode: "expect", expect: RUN_TARGET_REF_EXPECT }),
    /"any_def" is not exported from module "lib"/,
  );
});

test("validateRef: bare_send_rhs rejects non-exported symbol before kind check", () => {
  const importedMod = minimalModule({
    filePath: "lib.jh",
    exports: ["exported_wf"],
    defs: [wf("exported_wf"), { ...wf("private_wf"), loc: { line: 2, col: 1 } }],
  });
  importedMod.defs[1].name = "private_wf";
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
        lookupImportedKind: () => "def",
      }),
    /"private_wf" is not exported from module "lib"/,
  );
});
