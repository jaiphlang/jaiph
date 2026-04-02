import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function latestRunDir(runsRoot: string): string {
  if (!existsSync(runsRoot)) {
    return "";
  }
  let best = "";
  let bestMtime = 0;
  for (const d of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dayPath = join(runsRoot, d.name);
    for (const run of readdirSync(dayPath, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const p = join(dayPath, run.name);
      const st = statSync(p);
      if (st.mtimeMs >= bestMtime) {
        bestMtime = st.mtimeMs;
        best = p;
      }
    }
  }
  return best;
}

function parseJsonl(content: string): unknown[] {
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("run_summary.jsonl: workflow, steps, log, inbox dispatch stream", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-summary-jsonl-"));
  try {
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const jh = join(root, "app.jh");
    writeFileSync(
      jh,
      [
        "channel greetings",
        "",
        'script emit_greeting = `echo "hello-inbox"`',
        "",
        "workflow sender() {",
        "  log \"sending\"",
        "  logerr \"warn-line\"",
        "  greetings <- run emit_greeting()",
        "}",
        "",
        'script write_received_file = `echo "$1" > received.txt`',
        "",
        "workflow receiver() {",
        "  run write_received_file(\"$1\")",
        "}",
        "",
        "workflow default() {",
        "  run sender()",
        "  greetings -> receiver",
        "}",
        "",
      ].join("\n"),
    );

    const runResult = spawnSync("node", [cliPath, "run", jh], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        JAIPH_DOCKER_ENABLED: "false",
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(runResult.status, 0, runResult.stderr);

    const runsRoot = join(root, ".jaiph/runs");
    const runDir = latestRunDir(runsRoot);
    assert.ok(runDir, "run dir");
    const summaryPath = join(runDir, "run_summary.jsonl");
    assert.equal(existsSync(summaryPath), true);
    const events = parseJsonl(readFileSync(summaryPath, "utf8"));

    const types = events.map((e) => (e as { type: string }).type);
    assert.ok(types.includes("WORKFLOW_START"), types.join(","));
    assert.ok(types.includes("WORKFLOW_END"), types.join(","));
    assert.ok(types.includes("STEP_START"), types.join(","));
    assert.ok(types.includes("STEP_END"), types.join(","));
    assert.ok(types.includes("LOG"), types.join(","));
    assert.ok(types.includes("LOGERR"), types.join(","));
    assert.ok(types.includes("INBOX_ENQUEUE"), types.join(","));

    const wfStarts = events.filter((e) => (e as { type: string }).type === "WORKFLOW_START");
    assert.ok(wfStarts.length >= 1);
    for (const e of events) {
      const o = e as Record<string, unknown>;
      assert.equal(o.event_version, 1, `missing event_version: ${JSON.stringify(o).slice(0, 80)}`);
      assert.ok(typeof o.ts === "string" && (o.ts as string).length > 10);
      assert.ok(typeof o.run_id === "string" && (o.run_id as string).length > 0);
    }

    const stepEnds = events.filter((e) => (e as { type: string }).type === "STEP_END") as Array<{
      id: string;
      seq: number;
      depth: number;
    }>;
    assert.ok(stepEnds.length >= 1);
    assert.ok(typeof stepEnds[0].id === "string");
    assert.equal(typeof stepEnds[0].seq, "number");

    const logEv = events.find((e) => (e as { type: string }).type === "LOG") as {
      message: string;
      depth: number;
    };
    assert.ok(logEv);
    assert.match(logEv.message, /sending/);
    const logErrEv = events.find((e) => (e as { type: string }).type === "LOGERR") as {
      message: string;
      depth: number;
    };
    assert.ok(logErrEv);
    assert.match(logErrEv.message, /warn-line/);

    const enq = events.find((e) => (e as { type: string }).type === "INBOX_ENQUEUE") as {
      channel: string;
    };
    assert.ok(enq);
    assert.equal(enq.channel, "greetings");

    const order = types.join(",");
    const idx = (t: string) => types.indexOf(t);
    assert.ok(idx("WORKFLOW_START") < idx("STEP_END"), order);
    assert.ok(idx("LOG") < idx("INBOX_ENQUEUE"), order);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run_summary.jsonl: STEP_END remains parseable for legacy consumers (event_version additive)", () => {
  const root = mkdtempSync(join(tmpdir(), "jaiph-run-summary-legacy-"));
  try {
    const cliPath = join(process.cwd(), "dist/src/cli.js");
    const jh = join(root, "t.jh");
    writeFileSync(
      jh,
      ['script emit_x = `echo "x"`', "workflow default() {", "  run emit_x()", "}", ""].join("\n"),
    );
    const runResult = spawnSync("node", [cliPath, "run", jh], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, JAIPH_DOCKER_ENABLED: "false" },
    });
    assert.equal(runResult.status, 0, runResult.stderr);
    const runDir = latestRunDir(join(root, ".jaiph/runs"));
    const lines = readFileSync(join(runDir, "run_summary.jsonl"), "utf8")
      .trim()
      .split("\n");
    const stepEndLine = lines.find((l) => l.includes('"type":"STEP_END"'));
    assert.ok(stepEndLine);
    const o = JSON.parse(stepEndLine!) as { type: string; status: number; event_version?: number };
    assert.equal(o.type, "STEP_END");
    assert.equal(o.event_version, 1);
    assert.equal(typeof o.status, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
