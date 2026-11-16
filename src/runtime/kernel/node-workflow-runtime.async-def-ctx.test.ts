import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeGraph } from "./graph";
import { NodeWorkflowRuntime } from "./node-workflow-runtime";
import { loadModuleGraph, buildScriptsFromGraph } from "../../transpiler";

// Per-async-branch def context. `async slow(); async fast()` run concurrently;
// each branch carries its OWN def-context stack (like the per-branch frame
// stack) so the current def a branch reads — the `send` sender, and the
// def-level `agent.model` / `run.recover_limit` resolved mid-branch — is never
// taken from an interleaved sibling. The slow branch sleeps the least and fires
// first while the fast branch is still suspended on top of the shared stack: a
// single shared stack would attribute the slow branch's work to `fast`.

// Keys set on process.env by the runtime (env === process.env here, so the
// kernel's journal writer actually writes run_summary.jsonl). Snapshot/restore.
const TOUCHED = [
  "JAIPH_TEST_MODE", "JAIPH_RUNS_DIR", "JAIPH_SCRIPTS", "JAIPH_WORKSPACE",
  "JAIPH_RUN_DIR", "JAIPH_RUN_SUMMARY_FILE", "JAIPH_ARTIFACTS_DIR", "JAIPH_RUN_ID",
  "JAIPH_SOURCE_FILE", "JAIPH_MOCK_RESPONSES_JSON", "JAIPH_AGENT_MODEL",
  "JAIPH_AGENT_MODEL_LOCKED",
];

function readJournal(runDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(runDir, "run_summary.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function runSource(
  root: string,
  source: string,
  extraEnv: Record<string, string> = {},
): Promise<{ runDir: string; status: number }> {
  const jh = join(root, "flow.jh");
  writeFileSync(jh, source);
  const moduleGraph = loadModuleGraph(jh);
  const { scriptsDir } = buildScriptsFromGraph(moduleGraph, root);
  const graph = buildRuntimeGraph(moduleGraph);

  process.env.JAIPH_TEST_MODE = "1";
  process.env.JAIPH_RUNS_DIR = join(root, ".jaiph", "runs");
  process.env.JAIPH_SCRIPTS = scriptsDir;
  process.env.JAIPH_WORKSPACE = root;
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;

  const runtime = new NodeWorkflowRuntime(graph, { env: process.env, cwd: root, suppressLiveEvents: true });
  const status = await runtime.runRoot("main", []);
  return { runDir: runtime.getRunDir(), status };
}

// Acceptance: two async defs, one slow sender; the dispatched message's sender
// and the journal's INBOX_ENQUEUE.sender are the SENDING def, not whichever
// branch happened to be on top of a shared stack.
test("async branch: send sender is the sending def, not an interleaved sibling", async () => {
  const saved = TOUCHED.map((k) => [k, process.env[k]] as const);
  const root = mkdtempSync(join(tmpdir(), "jaiph-async-sender-"));
  try {
    const source = [
      "channel results -> receiver",
      "",
      "def receiver(content, chan, sender) {",
      '  log "recv ${content}|${sender}"',
      "}",
      "",
      "def slow() {",
      "  'sleep 0.05'()", // fires first, while fast() is still suspended on top
      '  send "slow" -> results',
      "}",
      "",
      "def fast() {",
      "  'sleep 0.6'()", // stays on top of a shared stack when slow() sends
      '  send "fast" -> results',
      "}",
      "",
      "export def main() {",
      "  const a = async slow()",
      "  const b = async fast()",
      "}",
      "",
    ].join("\n");
    const { runDir, status } = await runSource(root, source);
    assert.equal(status, 0, "workflow ran to completion");

    const events = readJournal(runDir);

    // The slow branch sends first (seq 001); the fast branch sends later (seq 002).
    const enqueue = events.filter((e) => e.type === "INBOX_ENQUEUE");
    const bySeq = new Map(enqueue.map((e) => [e.inbox_seq, e.sender]));
    assert.equal(bySeq.get("001"), "slow", "first enqueue is from the slow def");
    assert.equal(bySeq.get("002"), "fast", "second enqueue is from the fast def");

    // The dispatched message the receiver actually saw pairs content with sender.
    const logs = events.filter((e) => e.type === "LOG").map((e) => e.message);
    assert.ok(logs.includes("recv slow|slow"), `expected "recv slow|slow" in ${JSON.stringify(logs)}`);
    assert.ok(logs.includes("recv fast|fast"), `expected "recv fast|fast" in ${JSON.stringify(logs)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// Acceptance: two async defs with different def-level agent.model, each
// interleaved with a sleep; each prompt uses its OWN def's model (asserted
// through the PROMPT_START event, correlated to the def by prompt preview).
test("async branch: each prompt uses its own def's agent.model", async () => {
  const saved = TOUCHED.map((k) => [k, process.env[k]] as const);
  const root = mkdtempSync(join(tmpdir(), "jaiph-async-model-"));
  try {
    const source = [
      "def slow() {",
      "  config {",
      '    agent.model = "slow-model"',
      "  }",
      "  'sleep 0.05'()",
      '  const r = prompt "slow prompt"',
      "}",
      "",
      "def fast() {",
      "  config {",
      '    agent.model = "fast-model"',
      "  }",
      "  'sleep 0.6'()",
      '  const r = prompt "fast prompt"',
      "}",
      "",
      "export def main() {",
      "  const a = async slow()",
      "  const b = async fast()",
      "}",
      "",
    ].join("\n");
    // Operator env model must be absent so the def-level config model resolves.
    delete process.env.JAIPH_AGENT_MODEL;
    delete process.env.JAIPH_AGENT_MODEL_LOCKED;
    const { runDir, status } = await runSource(root, source, {
      JAIPH_MOCK_RESPONSES_JSON: JSON.stringify(["ok", "ok"]),
    });
    assert.equal(status, 0, "workflow ran to completion");

    const starts = readJournal(runDir).filter((e) => e.type === "PROMPT_START");
    const modelByPreview = new Map(
      starts.map((e) => [String(e.preview).slice(0, 11), e.model]),
    );
    assert.equal(modelByPreview.get("slow prompt"), "slow-model", "slow def's prompt uses slow-model");
    assert.equal(modelByPreview.get("fast prompt"), "fast-model", "fast def's prompt uses fast-model");
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// Acceptance: two async defs with different def-level run.recover_limit, each
// interleaved with a sleep; each failing step retries under its OWN def's limit.
// The recover body appends one byte per attempt to a per-def file, so the file
// length is the number of retries that actually ran.
test("async branch: each recover uses its own def's run.recover_limit", async () => {
  const saved = TOUCHED.map((k) => [k, process.env[k]] as const);
  const root = mkdtempSync(join(tmpdir(), "jaiph-async-recover-"));
  try {
    const patientFile = join(root, "patient.count");
    const hastyFile = join(root, "hasty.count");
    const source = [
      "def patient() {",
      "  config {",
      "    run.recover_limit = 3",
      "  }",
      "  'sleep 0.05'()",
      `  'exit 1'() recover(e) { 'printf x >> ${patientFile}'() }`,
      "}",
      "",
      "def hasty() {",
      "  config {",
      "    run.recover_limit = 0",
      "  }",
      "  'sleep 0.6'()",
      `  'exit 1'() recover(e) { 'printf x >> ${hastyFile}'() }`,
      "}",
      "",
      "export def main() {",
      "  const a = async patient()",
      "  const b = async hasty()",
      "}",
      "",
    ].join("\n");
    const { status } = await runSource(root, source);
    // Both branches exhaust their retries and fail, so the run fails overall.
    assert.notEqual(status, 0, "both failing branches fail the run");

    const patientRetries = existsSync(patientFile) ? readFileSync(patientFile, "utf8").length : 0;
    const hastyRetries = existsSync(hastyFile) ? readFileSync(hastyFile, "utf8").length : 0;
    assert.equal(patientRetries, 3, "patient def retried under its own recover_limit of 3");
    assert.equal(hastyRetries, 0, "hasty def retried under its own recover_limit of 0");
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
