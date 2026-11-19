import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";
import { loadModuleGraph } from "../../transpiler";
import { buildScriptsFromGraph } from "../../transpiler";
import { CHAIN_KEY_ENV, generateChainKey, verifyRunJournal, verifyRunSummaryChain, writeChainKey } from "./emit";
import { scrubPromptEnv } from "./env-allowlist";

// Security regression for finding H-3: the run audit journal is written by the
// trusted kernel under a per-run HMAC key that the audited workflow never sees.
// A script step can neither read the key/journal path from its env, nor forge a
// journal that verifies, nor silently delete the authoritative record.

const WF = [
  "script dump_env_impl = 'env > env_dump.txt'",
  "def dump_env() {",
  "  dump_env_impl()",
  "}",
  "",
  "script tamper_impl = '''",
  ': > "$JAIPH_RUN_DIR/run_summary.jsonl"',
  "'''",
  "def tamper() {",
  "  tamper_impl()",
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
  "JAIPH_AUDIT_KEY_DIR",
];

async function runWorkflow(
  prefix: string,
  symbol: string,
  key: string,
  source: string = WF,
): Promise<{ root: string; runDir: string }> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const jh = join(root, "tools.jh");
  writeFileSync(jh, source);
  const moduleGraph = loadModuleGraph(jh);
  const { scriptsDir } = buildScriptsFromGraph(moduleGraph, root);
  const graph = buildRuntimeGraph(moduleGraph);

  process.env[CHAIN_KEY_ENV] = key;
  process.env.JAIPH_TEST_MODE = "1";
  process.env.JAIPH_RUNS_DIR = join(root, ".jaiph", "runs");
  process.env.JAIPH_SCRIPTS = scriptsDir;
  process.env.JAIPH_WORKSPACE = root;
  // Isolate the operator-side key store to this workspace (outside the run dir)
  // so the test never touches the real home store (finding M-3).
  process.env.JAIPH_AUDIT_KEY_DIR = join(root, ".jaiph", "audit-keys");

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

// Production off-process path: the host hands the key to the runner through the
// chain-key file, and the runner passes it as `opts.chainKey` — NOT on the
// kernel env. The journal must key off that in-memory value (so it verifies),
// while the key stays absent from both the kernel env and any script subprocess.
test("audit chain: an off-process opts.chainKey keys the journal without ever touching the env", async () => {
  const saved = TOUCHED.map((k) => [k, process.env[k]] as const);
  const key = generateChainKey();
  try {
    const root = mkdtempSync(join(tmpdir(), "jaiph-audit-opts-"));
    const jh = join(root, "tools.jh");
    writeFileSync(jh, WF);
    const moduleGraph = loadModuleGraph(jh);
    const { scriptsDir } = buildScriptsFromGraph(moduleGraph, root);
    const graph = buildRuntimeGraph(moduleGraph);

    // Deliberately do NOT set CHAIN_KEY_ENV on the env — mirror the runner, which
    // reads the key off-process and never puts it back on process.env.
    delete process.env[CHAIN_KEY_ENV];
    process.env.JAIPH_TEST_MODE = "1";
    process.env.JAIPH_RUNS_DIR = join(root, ".jaiph", "runs");
    process.env.JAIPH_SCRIPTS = scriptsDir;
    process.env.JAIPH_WORKSPACE = root;
    process.env.JAIPH_AUDIT_KEY_DIR = join(root, ".jaiph", "audit-keys");

    const runtime = new NodeWorkflowRuntime(graph, {
      env: process.env,
      cwd: root,
      suppressLiveEvents: true,
      chainKey: key,
    });
    const status = await runtime.runRoot("dump_env", []);
    assert.equal(status, 0, "workflow ran to completion");
    const runDir = process.env.JAIPH_RUN_DIR!;

    // The key never rode on the kernel env...
    assert.equal(process.env[CHAIN_KEY_ENV], undefined, "the key must stay off the kernel env");
    // ...nor on the script subprocess env...
    const dump = readFileSync(join(root, "env_dump.txt"), "utf8");
    assert.ok(!dump.includes("JAIPH_CHAIN_KEY"), "the chain-key env var must not reach a script");
    assert.ok(!dump.includes(key), "the chain-key value must not reach a script");
    // ...yet the journal verifies under the in-memory key once persisted.
    writeChainKey(runDir, key);
    const res = verifyRunJournal(runDir);
    assert.equal(res.verified, true);
    assert.equal(res.ok, true, res.error);
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

// Inbox lifecycle events (INBOX_ENQUEUE / INBOX_DISPATCH_*) are written through
// the emitter's audit chain, not around it. A run that uses `send` over a routed
// channel must still produce a journal whose keyed hash chain verifies — before
// the fix those lines were appended without a `prev_hash` and broke the chain.
const INBOX_WF = [
  "channel findings -> analyst",
  "def analyst(msg) {",
  '  log "analyst got ${msg}"',
  "}",
  "def scanner() {",
  '  send "issue found" -> findings',
  "}",
  "export def main() {",
  "  scanner()",
  "}",
  "",
].join("\n");

test("audit chain: a routed send keeps the journal chain intact", async () => {
  const saved = TOUCHED.map((k) => [k, process.env[k]] as const);
  const key = generateChainKey();
  try {
    const { root, runDir } = await runWorkflow("jaiph-audit-inbox-", "main", key, INBOX_WF);
    const summary = join(runDir, "run_summary.jsonl");
    const lines = readFileSync(summary, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const inbox = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => String(e.type).startsWith("INBOX_"));
    // The send is routed, so all three inbox lifecycle events must be present...
    const inboxTypes = inbox.map((e) => e.type);
    assert.deepEqual(inboxTypes, ["INBOX_ENQUEUE", "INBOX_DISPATCH_START", "INBOX_DISPATCH_COMPLETE"]);
    // ...each carrying a chain link (the bug was these lines having no prev_hash)...
    for (const e of inbox) {
      assert.equal(typeof e.prev_hash, "string", `${String(e.type)} must carry prev_hash`);
    }
    // ...and the whole keyed chain verifies, ending at the RUN_END terminal marker.
    const res = verifyRunSummaryChain(summary, key, { requireTerminal: true });
    assert.equal(res.ok, true, res.error);
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
