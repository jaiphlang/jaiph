import test from "node:test";
import assert from "node:assert/strict";
import {
  preflightAgentCredentials,
  collectEntryBackends,
  E_AGENT_CREDENTIALS,
} from "./preflight-credentials";
import type {
  jaiphModule,
  WorkflowDef,
  WorkflowMetadata,
  WorkflowStepDef,
} from "../../types";

function emptyModule(filePath: string, metadata?: WorkflowMetadata): jaiphModule {
  return {
    filePath,
    metadata,
    imports: [],
    channels: [],
    exports: [],
    rules: [],
    scripts: [],
    workflows: [],
  };
}

function workflow(
  name: string,
  metadata?: WorkflowMetadata,
  steps: WorkflowStepDef[] = [],
): WorkflowDef {
  return {
    name,
    params: [],
    comments: [],
    steps,
    metadata,
    loc: { line: 1, col: 1 },
  };
}

/** A trivial `const r = prompt "..."` step — used to make the entry file "use prompt". */
function promptStep(): WorkflowStepDef {
  return {
    type: "const",
    name: "r",
    value: { kind: "prompt", raw: "\"hi\"", loc: { line: 1, col: 1 } },
    loc: { line: 1, col: 1 },
  };
}

const ENTRY = "/proj/main.jh";

/**
 * Realistic runtimeEnv shape. `resolveRuntimeEnv` populates JAIPH_AGENT_BACKEND
 * from module-level config when the user has not set the env var themselves, so
 * by the time pre-flight runs the env already reflects the module-level backend.
 */
function envFor(moduleBackend: string | undefined, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return moduleBackend
    ? { JAIPH_AGENT_BACKEND: moduleBackend, ...extra }
    : { ...extra };
}

// ---------------------------------------------------------------------------
// AC1: Docker + claude + no creds → hard error with E_AGENT_CREDENTIALS
// ---------------------------------------------------------------------------

test("claude under Docker with no creds → E_AGENT_CREDENTIALS error", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
    dockerEnabled: true,
  });
  assert.equal(r.errors.length, 1);
  assert.equal(r.warnings.length, 0);
  assert.ok(r.errors[0].startsWith(E_AGENT_CREDENTIALS + ":"));
  assert.ok(r.errors[0].includes("claude"));
});

// ---------------------------------------------------------------------------
// AC2: Host + claude + no creds → warn but no error
// ---------------------------------------------------------------------------

test("claude on host with no creds → warning, no error (CLI login may work)", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
    dockerEnabled: false,
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].toLowerCase().includes("warning"));
  assert.ok(r.warnings[0].includes("claude"));
});

// ---------------------------------------------------------------------------
// Unsafe mode: the credential pre-flight is skipped entirely
// ---------------------------------------------------------------------------

test("unsafe mode (JAIPH_UNSAFE=true): claude with no creds → no warning, no error", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude", { JAIPH_UNSAFE: "true" }),
    dockerEnabled: false,
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
});

test("unsafe mode (JAIPH_UNSAFE=true): codex with no OPENAI_API_KEY → no hard error", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "codex" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("codex", { JAIPH_UNSAFE: "true" }),
    dockerEnabled: false,
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
});

// ---------------------------------------------------------------------------
// AC3: cursor host/Docker split + codex always-hard
// ---------------------------------------------------------------------------

test("cursor under Docker with no CURSOR_API_KEY → hard error", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "cursor" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("cursor"),
    dockerEnabled: true,
  });
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].includes("CURSOR_API_KEY"));
  assert.ok(r.errors[0].startsWith(E_AGENT_CREDENTIALS + ":"));
});

test("cursor on host with no CURSOR_API_KEY → warning, no error", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "cursor" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("cursor"),
    dockerEnabled: false,
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes("CURSOR_API_KEY"));
});

test("codex on host with no OPENAI_API_KEY → hard error", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "codex" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("codex"),
    dockerEnabled: false,
  });
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].includes("OPENAI_API_KEY"));
  assert.ok(r.errors[0].startsWith(E_AGENT_CREDENTIALS + ":"));
});

test("codex under Docker with no OPENAI_API_KEY → hard error", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "codex" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("codex"),
    dockerEnabled: true,
  });
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].includes("OPENAI_API_KEY"));
});

// ---------------------------------------------------------------------------
// AC4: Message content — backend name, model (when set), file path, scope
// ---------------------------------------------------------------------------

test("message contains backend, model, entry file path, and 'module config' scope", () => {
  const mod = emptyModule(ENTRY, {
    agent: { backend: "claude", model: "sonnet-4" },
  });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
    dockerEnabled: true,
  });
  const msg = r.errors[0];
  assert.ok(msg.includes("claude"), `missing backend name: ${msg}`);
  assert.ok(msg.includes("sonnet-4"), `missing model string: ${msg}`);
  assert.ok(msg.includes(ENTRY), `missing entry file path: ${msg}`);
  assert.ok(msg.includes("module config"), `missing scope label: ${msg}`);
});

test("message reports 'workflow <name>' scope when backend is set at workflow level", () => {
  const mod = emptyModule(ENTRY);
  mod.workflows = [
    workflow("review", {
      agent: { backend: "claude", model: "opus-4" },
    }),
  ];
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    // No module-level backend, so the env reflects the system default.
    runtimeEnv: {},
    dockerEnabled: true,
  });
  // Errors: claude (workflow review) + cursor (default, no CURSOR_API_KEY).
  const claudeErr = r.errors.find((e) => e.includes("claude"));
  assert.ok(claudeErr, "expected a claude error");
  assert.ok(claudeErr.includes("opus-4"));
  assert.ok(claudeErr.includes(ENTRY));
  assert.ok(claudeErr.includes("workflow review"), `missing 'workflow review' scope: ${claudeErr}`);
});

test("warning message also names backend/model/file/scope", () => {
  const mod = emptyModule(ENTRY, {
    agent: { backend: "claude", model: "haiku-4" },
  });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
    dockerEnabled: false,
  });
  const msg = r.warnings[0];
  assert.ok(msg.includes("claude"));
  assert.ok(msg.includes("haiku-4"));
  assert.ok(msg.includes(ENTRY));
  assert.ok(msg.includes("module config"));
});

test("message includes Docker forwarding remedy hint when Docker is on", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
    dockerEnabled: true,
  });
  assert.ok(
    r.errors[0].toLowerCase().includes("docker"),
    `expected Docker remedy hint: ${r.errors[0]}`,
  );
});

// ---------------------------------------------------------------------------
// AC5: With creds → silent (no false positives), including single-of-two for claude
// ---------------------------------------------------------------------------

test("claude under Docker with ANTHROPIC_API_KEY only → silent", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude", { ANTHROPIC_API_KEY: "sk-xxx" }),
    dockerEnabled: true,
  });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("claude under Docker with CLAUDE_CODE_OAUTH_TOKEN only → silent", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude", { CLAUDE_CODE_OAUTH_TOKEN: "tok-yyy" }),
    dockerEnabled: true,
  });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("cursor with CURSOR_API_KEY set → silent (both modes)", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "cursor" } });
  for (const dockerEnabled of [true, false]) {
    const r = preflightAgentCredentials({
      mod,
      inputAbs: ENTRY,
      runtimeEnv: envFor("cursor", { CURSOR_API_KEY: "k" }),
      dockerEnabled,
    });
    assert.deepEqual(r, { errors: [], warnings: [] }, `dockerEnabled=${dockerEnabled}`);
  }
});

test("codex on host with OPENAI_API_KEY set → silent", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "codex" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("codex", { OPENAI_API_KEY: "sk" }),
    dockerEnabled: false,
  });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("empty-value env vars do not satisfy the check", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "cursor" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("cursor", { CURSOR_API_KEY: "" }),
    dockerEnabled: true,
  });
  assert.equal(r.errors.length, 1);
});

// ---------------------------------------------------------------------------
// AC6: No in-file backend config, cursor default, host run → warn-only, no fail
// ---------------------------------------------------------------------------

test("no backend, no prompt — silent (no false positives, contract holds)", () => {
  // AC: "A workflow with no `prompt` step / no agent backend configured beyond
  // the default and `cursor` default on host does not hard-fail solely due to a
  // missing key (host warn-only contract holds)." No errors, no warnings either —
  // the pre-flight skips entirely when nothing demands credentials.
  const mod = emptyModule(ENTRY);
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: {},
    dockerEnabled: false,
  });
  assert.equal(r.errors.length, 0, `expected no hard errors, got: ${r.errors.join("\n")}`);
  assert.equal(r.warnings.length, 0);
});

test("no agent.backend configured, cursor default on host, no CURSOR_API_KEY, prompt used → warn only", () => {
  // When the workflow actually uses prompt, the warn-only contract activates.
  const mod = emptyModule(ENTRY);
  mod.workflows = [workflow("default", undefined, [promptStep()])];
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: {},
    dockerEnabled: false,
  });
  assert.equal(r.errors.length, 0, `expected no hard errors, got: ${r.errors.join("\n")}`);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.warnings[0].includes("cursor"));
});

test("no agent.backend configured, cursor default on host, CURSOR_API_KEY set, prompt used → silent", () => {
  const mod = emptyModule(ENTRY);
  mod.workflows = [workflow("default", undefined, [promptStep()])];
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: { CURSOR_API_KEY: "k" },
    dockerEnabled: false,
  });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("explicit backend in config but no prompt step → still checks (user committed to backend)", () => {
  // AC1 envisions a workflow whose entry file sets `agent.backend = "claude"`.
  // Even if no prompt step exists, the explicit declaration is a commitment
  // we honor by running the check.
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
    dockerEnabled: true,
  });
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].includes("claude"));
});

// ---------------------------------------------------------------------------
// AC7: Pre-flight checks post-forwarding env (non-allowlisted vars treated as missing)
// ---------------------------------------------------------------------------

test("codex under Docker: OPENAI_API_KEY on host is forwarded via allowlist → silent", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "codex" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("codex", { OPENAI_API_KEY: "sk-set-on-host" }),
    dockerEnabled: true,
  });
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
});

test("codex on host: OPENAI_API_KEY present → silent (no allowlist filter outside Docker)", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "codex" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("codex", { OPENAI_API_KEY: "sk-set-on-host" }),
    dockerEnabled: false,
  });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

test("claude under Docker: ANTHROPIC_API_KEY is allowlisted (ANTHROPIC_ prefix)", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude", { ANTHROPIC_API_KEY: "sk" }),
    dockerEnabled: true,
  });
  assert.deepEqual(r, { errors: [], warnings: [] });
});

// ---------------------------------------------------------------------------
// Distinct backends in entry file: each gets its own check
// ---------------------------------------------------------------------------

test("module-level claude + workflow-level cursor under Docker → claude and cursor errors", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  mod.workflows = [
    workflow("legacy", { agent: { backend: "cursor" } }),
  ];
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
    dockerEnabled: true,
  });
  // claude (module config) + cursor (workflow legacy).
  assert.equal(r.errors.length, 2);
  const joined = r.errors.join("\n");
  assert.ok(joined.includes("claude") && joined.includes("module config"));
  assert.ok(joined.includes("cursor") && joined.includes("workflow legacy"));
});

test("module config matches the effective env default → no duplicate check", () => {
  // realistic flow: resolveRuntimeEnv sets JAIPH_AGENT_BACKEND from module config,
  // so module-level "claude" and the default backend resolve to the same value.
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  const r = preflightAgentCredentials({
    mod,
    inputAbs: ENTRY,
    runtimeEnv: envFor("claude"),
    dockerEnabled: true,
  });
  assert.equal(r.errors.length, 1, `expected exactly one error, got: ${r.errors.join("\n")}`);
});

// ---------------------------------------------------------------------------
// collectEntryBackends: entry-file backend scan feeding the Docker env forward
// ---------------------------------------------------------------------------

test("collectEntryBackends: no config and no env → default cursor only", () => {
  const mod = emptyModule(ENTRY);
  assert.deepEqual(collectEntryBackends(mod, {}), ["cursor"]);
});

test("collectEntryBackends: module claude + workflow cursor → both, no duplicates", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  mod.workflows = [workflow("legacy", { agent: { backend: "cursor" } })];
  assert.deepEqual(collectEntryBackends(mod, envFor("claude")), ["claude", "cursor"]);
});

test("collectEntryBackends: JAIPH_AGENT_BACKEND env adds the effective default backend", () => {
  const mod = emptyModule(ENTRY, { agent: { backend: "claude" } });
  assert.deepEqual(
    collectEntryBackends(mod, { JAIPH_AGENT_BACKEND: "codex" }),
    ["claude", "codex"],
  );
});
