import test from "node:test";
import assert from "node:assert/strict";
import { applySandboxFlags } from "./env";
import { resolveDockerConfig, selectSandboxMode } from "../../runtime/docker";
import { confirmInplaceRun, _inplacePrompt } from "../../runtime/docker-inplace";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stubPrompt(): { restore: () => void; callCount: () => number } {
  const orig = _inplacePrompt.ask;
  let calls = 0;
  _inplacePrompt.ask = async (_q: string) => {
    calls += 1;
    return true;
  };
  return {
    restore: () => { _inplacePrompt.ask = orig; },
    callCount: () => calls,
  };
}

// ---------------------------------------------------------------------------
// applySandboxFlags: each flag normalizes into the runtime env map
// ---------------------------------------------------------------------------

test("applySandboxFlags: --inplace sets JAIPH_INPLACE=1", () => {
  const env: Record<string, string | undefined> = {};
  applySandboxFlags(env, { inplace: true });
  assert.equal(env.JAIPH_INPLACE, "1");
  assert.equal(env.JAIPH_UNSAFE, undefined);
  assert.equal(env.JAIPH_INPLACE_YES, undefined);
});

test("applySandboxFlags: --unsafe sets JAIPH_UNSAFE=true", () => {
  const env: Record<string, string | undefined> = {};
  applySandboxFlags(env, { unsafe: true });
  assert.equal(env.JAIPH_UNSAFE, "true");
  assert.equal(env.JAIPH_INPLACE, undefined);
});

test("applySandboxFlags: --yes sets JAIPH_INPLACE_YES=1", () => {
  const env: Record<string, string | undefined> = {};
  applySandboxFlags(env, { yes: true });
  assert.equal(env.JAIPH_INPLACE_YES, "1");
});

test("applySandboxFlags: no flags leaves env unchanged", () => {
  const env: Record<string, string | undefined> = { JAIPH_DEBUG: "true" };
  applySandboxFlags(env, {});
  assert.deepEqual(env, { JAIPH_DEBUG: "true" });
});

test("applySandboxFlags: pre-existing env values agree with flag (no conflict)", () => {
  const env: Record<string, string | undefined> = { JAIPH_INPLACE: "1" };
  applySandboxFlags(env, { inplace: true });
  assert.equal(env.JAIPH_INPLACE, "1");
});

test("applySandboxFlags: env-only path (no flags) still respected by callers — flag missing leaves env alone", () => {
  const env: Record<string, string | undefined> = { JAIPH_INPLACE: "1" };
  applySandboxFlags(env, {});
  assert.equal(env.JAIPH_INPLACE, "1");
});

// ---------------------------------------------------------------------------
// E_FLAG_CONFLICT: --inplace + --unsafe is contradictory
// ---------------------------------------------------------------------------

test("applySandboxFlags: --inplace + --unsafe both set → E_FLAG_CONFLICT", () => {
  const env: Record<string, string | undefined> = {};
  assert.throws(
    () => applySandboxFlags(env, { inplace: true, unsafe: true }),
    /E_FLAG_CONFLICT/,
  );
});

test("applySandboxFlags: --inplace flag + JAIPH_UNSAFE=true env → E_FLAG_CONFLICT", () => {
  const env: Record<string, string | undefined> = { JAIPH_UNSAFE: "true" };
  assert.throws(
    () => applySandboxFlags(env, { inplace: true }),
    /E_FLAG_CONFLICT/,
  );
});

test("applySandboxFlags: --unsafe flag + JAIPH_INPLACE=1 env → E_FLAG_CONFLICT", () => {
  const env: Record<string, string | undefined> = { JAIPH_INPLACE: "1" };
  assert.throws(
    () => applySandboxFlags(env, { unsafe: true }),
    /E_FLAG_CONFLICT/,
  );
});

test("applySandboxFlags: JAIPH_INPLACE=true (string) + JAIPH_UNSAFE=true env → E_FLAG_CONFLICT", () => {
  const env: Record<string, string | undefined> = { JAIPH_INPLACE: "true", JAIPH_UNSAFE: "true" };
  assert.throws(
    () => applySandboxFlags(env, {}),
    /E_FLAG_CONFLICT/,
  );
});

// ---------------------------------------------------------------------------
// End-to-end: flag-normalized env is consumed by the unmodified docker layer
// ---------------------------------------------------------------------------

test("--inplace alone (no env) → selectSandboxMode returns 'inplace'", () => {
  const env: Record<string, string | undefined> = {};
  applySandboxFlags(env, { inplace: true });
  assert.equal(selectSandboxMode(env), "inplace");
});

test("--unsafe alone (no env) → resolveDockerConfig().enabled === false", () => {
  const env: Record<string, string | undefined> = {};
  applySandboxFlags(env, { unsafe: true });
  const cfg = resolveDockerConfig(undefined, env);
  assert.equal(cfg.enabled, false);
});

test("env-only JAIPH_INPLACE still selects inplace (regression)", () => {
  // No flag — the runtime env already had it. selectSandboxMode picks it up.
  assert.equal(selectSandboxMode({ JAIPH_INPLACE: "1" }), "inplace");
});

test("env-only JAIPH_UNSAFE still disables Docker (regression)", () => {
  const cfg = resolveDockerConfig(undefined, { JAIPH_UNSAFE: "true" });
  assert.equal(cfg.enabled, false);
});

test("--yes alone (no env) → confirmInplaceRun does not invoke the prompt", async () => {
  const ws = mkdtempSync(join(tmpdir(), "jaiph-sandbox-flags-ws-"));
  const spy = stubPrompt();
  try {
    const env: Record<string, string | undefined> = {};
    applySandboxFlags(env, { yes: true });
    const proceed = await confirmInplaceRun(ws, env, true);
    assert.equal(proceed, true);
    assert.equal(spy.callCount(), 0, "prompt must not be invoked when --yes normalized into JAIPH_INPLACE_YES");
  } finally {
    spy.restore();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("flag and env agree on JAIPH_INPLACE — no conflict, single value persisted", () => {
  const env: Record<string, string | undefined> = { JAIPH_INPLACE: "1" };
  applySandboxFlags(env, { inplace: true });
  assert.equal(env.JAIPH_INPLACE, "1");
  assert.equal(selectSandboxMode(env), "inplace");
});
