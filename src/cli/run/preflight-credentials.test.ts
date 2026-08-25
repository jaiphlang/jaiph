import test from "node:test";
import assert from "node:assert/strict";
import { preflightAgentCredentials, E_AGENT_CREDENTIALS } from "./preflight-credentials";
import type {
  jaiphModule,
  Def,
  DefMetadata,
  StepDef,
} from "../../types";

function emptyModule(filePath: string, metadata?: DefMetadata): jaiphModule {
  return {
    filePath,
    metadata,
    imports: [],
    channels: [],
    exports: [],
    scripts: [],
    defs: [],
  };
}

function workflow(
  name: string,
  metadata?: DefMetadata,
  steps: StepDef[] = [],
): Def {
  return {
    name,
    params: [],
    comments: [],
    steps,
    metadata,
    loc: { line: 1, col: 1 },
  };
}

function promptStep(): StepDef {
  return {
    type: "const",
    name: "r",
    value: { kind: "prompt", raw: "\"hi\"", loc: { line: 1, col: 1 } },
    loc: { line: 1, col: 1 },
  };
}

const ENTRY = "/proj/main.jh";

function envFor(moduleBackend: string | undefined, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return moduleBackend
    ? { JAIPH_AGENT_BACKEND: moduleBackend, ...extra }
    : { ...extra };
}

test("claude with no creds → warning, no error (CLI login may work)", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].toLowerCase().includes("warning"));
  assert.ok(r.warnings[0].includes("claude"));
});

test("cursor with no CURSOR_API_KEY → warning, no error", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "cursor" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("cursor"),
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes("CURSOR_API_KEY"));
});

test("codex with no OPENAI_API_KEY → hard error", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "codex" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("codex"),
  });
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].includes("OPENAI_API_KEY"));
  assert.ok(r.errors[0].startsWith(E_AGENT_CREDENTIALS + ":"));
});

test("message contains backend, model, entry file path, and 'module config' scope", () => {
  const mod = emptyModule(ENTRY, {
    agent: { backend: "claude", model: "sonnet-4" },
  });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
  });
  const msg = r.warnings[0];
  assert.ok(msg.includes("claude"), `missing backend name: ${msg}`);
  assert.ok(msg.includes("sonnet-4"), `missing model string: ${msg}`);
  assert.ok(msg.includes(ENTRY), `missing entry file path: ${msg}`);
  assert.ok(msg.includes("module config"), `missing scope label: ${msg}`);
});

test("message reports 'def <name>' scope when backend is set at def level", () => {
  const mod = emptyModule(ENTRY);
  mod.defs = [
    workflow("review", {
      agent: { backend: "claude", model: "opus-4" },
    }),
  ];
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: {},
  });
  const claudeWarn = r.warnings.find((e) => e.includes("claude"));
  assert.ok(claudeWarn, "expected a claude warning");
  assert.ok(claudeWarn.includes("opus-4"));
  assert.ok(claudeWarn.includes(ENTRY));
  assert.ok(claudeWarn.includes("def review"), `missing 'def review' scope: ${claudeWarn}`);
});

test("claude with ANTHROPIC_API_KEY only → silent", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude", { ANTHROPIC_API_KEY: "sk-xxx" }),
  });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("claude with CLAUDE_CODE_OAUTH_TOKEN only → silent", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude", { CLAUDE_CODE_OAUTH_TOKEN: "tok-yyy" }),
  });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("cursor with CURSOR_API_KEY set → silent", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "cursor" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("cursor", { CURSOR_API_KEY: "k" }),
  });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("codex with OPENAI_API_KEY set → silent", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "codex" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("codex", { OPENAI_API_KEY: "sk" }),
  });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("empty-value env vars do not satisfy the check", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "cursor" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("cursor", { CURSOR_API_KEY: "" }),
  });
  assert.equal(r.warnings.length, 1);
});

test("no backend, no prompt — silent", () => {
  const mod = emptyModule(ENTRY);
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: {},
  });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("no agent.backend configured, cursor default, no CURSOR_API_KEY, prompt used → warn only", () => {
  const mod = emptyModule(ENTRY);
  mod.defs = [workflow("main", undefined, [promptStep()])];
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: {},
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes("cursor"));
});

test("explicit backend in config but no prompt step → still checks", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes("claude"));
});

test("module-level claude + def-level cursor → both warned", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  mod.defs = [
    workflow("legacy", { agent: { backend: "cursor" } }),
  ];
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
  });
  assert.equal(r.warnings.length, 2);
  const joined = r.warnings.join("\n");
  assert.ok(joined.includes("claude") && joined.includes("module config"));
  assert.ok(joined.includes("cursor") && joined.includes("def legacy"));
});

test("module config matches the effective env default → no duplicate check", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
  });
  assert.equal(r.warnings.length, 1, `expected exactly one warning, got: ${r.warnings.join("\n")}`);
});
