import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";
import { loadModuleGraph } from "../../transpile/module-graph";
import { buildScriptsFromGraph } from "../../transpiler";
import { CHAIN_KEY_ENV, generateChainKey, verifyRunJournal, writeChainKey } from "./emit";
import { scrubPromptEnv } from "./env-allowlist";

// Security regression for finding H-3: the run audit journal is written by the
// trusted kernel under a per-run HMAC key that the audited workflow never sees.
// A script step can neither read the key/journal path from its env, nor forge a
// journal that verifies, nor silently delete the authoritative record.

const WF = [
  // Dumps the script subprocess environment so the test can assert the key and
  // the journal path are absent from it.
  "workflow dump_env() {",
  "  env > env_dump.txt",
  "}",
  "",
  // Attempts to destroy the authoritative journal the way the finding describes.
  "workflow tamper() {",
  '  : > "$JAIPH_RUN_DIR/run_summary.jsonl"',
  "}",
  "",
].join("\n");

// Keys the runtime (or this test) sets on process.env. Mirroring the production
// child runner — where env === process.env, so `appendRunSummaryLine` (which
// reads process.env) actually writes the journal — means touching process.env;
// snapshot + restore all of them.
const TOUCHED = [
  CHAIN_KEY_ENV, "JAIPH_TEST_MODE", "JAIPH_RUNS_DIR", "JAIPH_SCRIPTS", "JAIPH_WORKSPACE",
  "JAIPH_RUN_DIR", "JAIPH_RUN_SUMMARY_FILE", "JAIPH_ARTIFACTS_DIR", "JAIPH_RUN_ID", "JAIPH_SOURCE_FILE",
];

async function runWorkflow(
  prefix: string,
  symbol: string,
  key: string,
): Promise<{ root: string; runDir: string }> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, WF);
  const moduleGraph = loadModuleGraph(jh);
  const { scriptsDir } = buildScriptsFromGraph(moduleGraph, root);
  const graph = buildRuntimeGraph(moduleGraph);

  process.env[CHAIN_KEY_ENV] = key;
  process.env.JAIPH_TEST_MODE = "1";
  process.env.JAIPH_RUNS_DIR = join(root, ".jaiph", "runs");
  process.env.JAIPH_SCRIPTS = scriptsDir;
  process.env.JAIPH_WORKSPACE = root;

  const runtime = new NodeWorkflowRuntime(graph, { env: process.env, cwd: root, suppressLiveEvents: true });
  const status = await runtime.runRoot(symbol, []);
  assert.equal(status, 0, "workflow ran to completion");
  return { root, runDir: process.env.JAIPH_RUN_DIR! };
}

// AC2: the key is absent from a script subprocess env; AC1 (part 1): so is the
// journal path — the script is not even handed the file to overwrite.
test("audit chain: the chain key and journal path never reach a script subprocess", async () => {
  const saved = TOUCHED.map((k) => [k, process.env[k]] as const);
  const key = generateChainKey();
  try {
    const { root } = await runWorkflow("jaiph-audit-env-", "dump_env", key);
    const dump = readFileSync(join(root, "env_dump.txt"), "utf8");
    assert.ok(!dump.includes("JAIPH_CHAIN_KEY"), "the chain-key env var must not reach a script");
    assert.ok(!dump.includes(key), "the chain-key value must not appear in the script env");
    assert.ok(!dump.includes("JAIPH_RUN_SUMMARY_FILE"), "the journal path must not reach a script");
    // Sanity: the dump captured a real env, and JAIPH_RUN_DIR is still exported
    // (scripts legitimately use it — the file is protected by the key, not by
    // hiding the directory).
    assert.match(dump, /^JAIPH_RUN_DIR=/m);
    // The trusted kernel process, by contrast, does hold the key.
    assert.equal(process.env[CHAIN_KEY_ENV], key);
    rmSync(root, { recursive: true, force: true });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// AC1 (part 2): a script step that deletes/truncates the journal cannot do so
// undetected — once the host persists the key, verification hard-fails.
test("audit chain: a script truncating the journal is detected at the read boundary", async () => {
  const saved = TOUCHED.map((k) => [k, process.env[k]] as const);
  const key = generateChainKey();
  try {
    const { root, runDir } = await runWorkflow("jaiph-audit-tamper-", "tamper", key);
    // The host persists the key beside the journal at finalize (as run.ts /
    // call.ts do). The workflow never had it, so it could not re-forge the chain.
    writeChainKey(runDir, key);
    const res = verifyRunJournal(runDir);
    assert.equal(res.verified, true, "a key was persisted, so the boundary verifies");
    assert.equal(res.ok, false, "the script's truncation of the journal is detected");
    rmSync(root, { recursive: true, force: true });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// AC2 (agent boundary): the key is dropped from a prompt-agent subprocess env
// even though the JAIPH_ prefix would otherwise forward it into the container.
test("audit chain: scrubPromptEnv drops the chain key but keeps other JAIPH_ control vars", () => {
  const scrubbed = scrubPromptEnv(
    { [CHAIN_KEY_ENV]: "deadbeef", JAIPH_RUN_ID: "run-1", PATH: "/usr/bin" },
    "claude",
  );
  assert.equal(scrubbed[CHAIN_KEY_ENV], undefined, "the chain key must not cross to an agent");
  assert.equal(scrubbed.JAIPH_RUN_ID, "run-1", "ordinary JAIPH_ control vars still cross");
  assert.equal(scrubbed.PATH, "/usr/bin");
});
