import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { resolveRuntimeEnv, applyEnvGrant } from "./env";
import { resolveEnvPairs } from "../shared/usage";
import type { JaiphConfig } from "../../config";

test("resolveRuntimeEnv: sets JAIPH_WORKSPACE from workspaceRoot", () => {
  const config: JaiphConfig = {};
  const env = resolveRuntimeEnv(config, "/workspace", "/workspace/main.sh");
  assert.equal(env.JAIPH_WORKSPACE, "/workspace");
});

test("resolveRuntimeEnv: does not set JAIPH_STDLIB (removed)", () => {
  const saved = process.env.JAIPH_STDLIB;
  process.env.JAIPH_STDLIB = "/tmp/should-be-cleaned";
  try {
    const config: JaiphConfig = {};
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_STDLIB, undefined);
  } finally {
    if (saved !== undefined) process.env.JAIPH_STDLIB = saved;
    else delete process.env.JAIPH_STDLIB;
  }
});

test("resolveRuntimeEnv: does not map agent.model from config into JAIPH_AGENT_MODEL", () => {
  const saved = process.env.JAIPH_AGENT_MODEL;
  delete process.env.JAIPH_AGENT_MODEL;
  try {
    const config: JaiphConfig = { agent: { model: "sonnet" } };
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    // Config agent.model must not leak into the env var; it stays defined-empty
    // so scripts reading $JAIPH_AGENT_MODEL under `set -u` don't hit "unbound
    // variable".
    assert.equal(env.JAIPH_AGENT_MODEL, "");
  } finally {
    if (saved !== undefined) process.env.JAIPH_AGENT_MODEL = saved;
  }
});

test("resolveRuntimeEnv: preserves user-provided JAIPH_AGENT_MODEL", () => {
  const saved = process.env.JAIPH_AGENT_MODEL;
  process.env.JAIPH_AGENT_MODEL = "opus";
  try {
    const config: JaiphConfig = { agent: { model: "sonnet" } };
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_AGENT_MODEL, "opus");
  } finally {
    if (saved !== undefined) {
      process.env.JAIPH_AGENT_MODEL = saved;
    } else {
      delete process.env.JAIPH_AGENT_MODEL;
    }
  }
});

test("resolveRuntimeEnv: marks env-provided keys as locked", () => {
  const saved = process.env.JAIPH_DEBUG;
  process.env.JAIPH_DEBUG = "true";
  try {
    const config: JaiphConfig = {};
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_DEBUG_LOCKED, "1");
  } finally {
    if (saved !== undefined) {
      process.env.JAIPH_DEBUG = saved;
    } else {
      delete process.env.JAIPH_DEBUG;
    }
  }
});

test("resolveRuntimeEnv: cleans transient keys", () => {
  const saved = process.env.JAIPH_RUN_DIR;
  const savedMeta = process.env.JAIPH_META_FILE;
  const savedGraph = process.env.JAIPH_MODULE_GRAPH_FILE;
  process.env.JAIPH_RUN_DIR = "/old/run";
  process.env.JAIPH_META_FILE = "/stale/meta.txt";
  process.env.JAIPH_MODULE_GRAPH_FILE = "/stale/graph.json";
  try {
    const config: JaiphConfig = {};
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_RUN_DIR, undefined);
    assert.equal(env.JAIPH_META_FILE, undefined);
    assert.equal(env.BASH_ENV, undefined);
    assert.equal(env.JAIPH_PRECEDING_FILES, undefined);
    assert.equal(env.JAIPH_RUN_SUMMARY_FILE, undefined);
    assert.equal(env.JAIPH_MODULE_GRAPH_FILE, undefined);
  } finally {
    if (saved !== undefined) {
      process.env.JAIPH_RUN_DIR = saved;
    } else {
      delete process.env.JAIPH_RUN_DIR;
    }
    if (savedMeta !== undefined) {
      process.env.JAIPH_META_FILE = savedMeta;
    } else {
      delete process.env.JAIPH_META_FILE;
    }
    if (savedGraph !== undefined) {
      process.env.JAIPH_MODULE_GRAPH_FILE = savedGraph;
    } else {
      delete process.env.JAIPH_MODULE_GRAPH_FILE;
    }
  }
});

test("resolveRuntimeEnv: sets JAIPH_SOURCE_FILE from inputAbs basename", () => {
  const config: JaiphConfig = {};
  const env = resolveRuntimeEnv(config, "/ws", "/ws/deep/main.sh");
  assert.equal(env.JAIPH_SOURCE_FILE, "main.sh");
});

test("resolveRuntimeEnv: defaults JAIPH_AGENT_TRUSTED_WORKSPACE to workspaceRoot", () => {
  const saved = process.env.JAIPH_AGENT_TRUSTED_WORKSPACE;
  delete process.env.JAIPH_AGENT_TRUSTED_WORKSPACE;
  try {
    const config: JaiphConfig = {};
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_AGENT_TRUSTED_WORKSPACE, "/ws");
  } finally {
    if (saved !== undefined) process.env.JAIPH_AGENT_TRUSTED_WORKSPACE = saved;
  }
});

// ---------------------------------------------------------------------------
// resolveEnvPairs (--env passthrough resolution)
// ---------------------------------------------------------------------------

test("resolveEnvPairs: KEY=VALUE form uses the explicit value verbatim", () => {
  const pairs = resolveEnvPairs([{ key: "GREETING", value: "hi" }], {});
  assert.deepEqual(pairs, { GREETING: "hi" });
});

test("resolveEnvPairs: empty explicit value is preserved (not treated as unset)", () => {
  const pairs = resolveEnvPairs([{ key: "EMPTY", value: "" }], {});
  assert.deepEqual(pairs, { EMPTY: "" });
});

test("resolveEnvPairs: bare KEY forwards the host's current value", () => {
  const pairs = resolveEnvPairs([{ key: "TOKEN" }], { TOKEN: "from-host" });
  assert.deepEqual(pairs, { TOKEN: "from-host" });
});

test("resolveEnvPairs: bare KEY unset on the host aborts with E_ENV_MISSING", () => {
  assert.throws(
    () => resolveEnvPairs([{ key: "TOKEN" }], {}),
    /E_ENV_MISSING: Jaiph requires TOKEN to be set.*--env TOKEN/,
  );
});

test("resolveEnvPairs: later duplicate wins (flag order)", () => {
  const pairs = resolveEnvPairs(
    [{ key: "K", value: "first" }, { key: "K", value: "second" }],
    {},
  );
  assert.deepEqual(pairs, { K: "second" });
});

test("resolveEnvPairs: empty spec list yields an empty record", () => {
  assert.deepEqual(resolveEnvPairs([], { ANYTHING: "x" }), {});
});

// ---------------------------------------------------------------------------
// Runner env is built from an allowlist, not a copy of the host env.
// ---------------------------------------------------------------------------

test("resolveRuntimeEnv: an ungranted host secret is not forwarded onto the runner env", () => {
  const saved = process.env.UNOWNED_SECRET;
  process.env.UNOWNED_SECRET = "x";
  try {
    const env = resolveRuntimeEnv({}, "/ws", "/ws/main.sh");
    // Today's `{ ...process.env }` fails this: the ungranted secret leaked onto
    // the workflow-leader env.
    assert.equal(env.UNOWNED_SECRET, undefined);
  } finally {
    if (saved !== undefined) process.env.UNOWNED_SECRET = saved;
    else delete process.env.UNOWNED_SECRET;
  }
});

test("resolveRuntimeEnv: process basics (PATH, HOME) still appear on the runner env", () => {
  const env = resolveRuntimeEnv({}, "/ws", "/ws/main.sh");
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HOME, process.env.HOME);
  assert.equal(env.JAIPH_WORKSPACE, "/ws");
});

test("resolveRuntimeEnv: a backend credential (ANTHROPIC_API_KEY) is forwarded when set", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  try {
    const env = resolveRuntimeEnv({}, "/ws", "/ws/main.sh");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-test");
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  }
});

// ---------------------------------------------------------------------------
// applyEnvGrant: --env VALUES stay off the runner env (held off-process).
// ---------------------------------------------------------------------------

test("applyEnvGrant: a --env value never lands on the runner env; only its name goes on JAIPH_ENV_GRANT", () => {
  const runtimeEnv: Record<string, string | undefined> = {};
  const { grantFile } = applyEnvGrant(runtimeEnv, { GITHUB_TOKEN: "ghs_test" });
  try {
    // Today's `Object.assign(runtimeEnv, extraEnv)` fails this: it copied the
    // value straight onto the env the runner leader is spawned with.
    assert.equal(runtimeEnv.GITHUB_TOKEN, undefined);
    assert.equal(runtimeEnv.JAIPH_ENV_GRANT, "GITHUB_TOKEN");
    assert.ok(grantFile, "a granted value is written to an off-process grant file");
  } finally {
    if (grantFile) rmSync(dirname(grantFile), { recursive: true, force: true });
  }
});

test("applyEnvGrant: no --env keys writes no grant file and an empty grant list", () => {
  const runtimeEnv: Record<string, string | undefined> = {};
  const { grantFile } = applyEnvGrant(runtimeEnv, {});
  assert.equal(grantFile, undefined);
  assert.equal(runtimeEnv.JAIPH_ENV_GRANT, "");
});

test("resolveRuntimeEnv: sets debug from config", () => {
  const savedDebug = process.env.JAIPH_DEBUG;
  delete process.env.JAIPH_DEBUG;
  try {
    const config: JaiphConfig = { run: { debug: true } };
    const env = resolveRuntimeEnv(config, "/ws", "/ws/main.sh");
    assert.equal(env.JAIPH_DEBUG, "true");
  } finally {
    if (savedDebug !== undefined) {
      process.env.JAIPH_DEBUG = savedDebug;
    } else {
      delete process.env.JAIPH_DEBUG;
    }
  }
});
