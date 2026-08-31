import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadGeneration } from "./generation";
import { createServerLog, type OperatorLog } from "./server-log";
import { callDef, type DefCallContext } from "./workflow-call";

// End-to-end operator-log coverage over the real host spawn path
// (`callDef` → `callDefHost`), the shared choke point behind both
// `jaiph mcp` tool calls and `jaiph serve` runs. Each test drives a captured
// stderr `log` sink and asserts the operator lines land there — never on the
// call result (the value that would go to the protocol channel).

function operatorFor(
  lines: string[],
  opts: { mirror?: boolean } = {},
): OperatorLog {
  return {
    log: createServerLog({
      label: "jaiph mcp",
      write: (line) => void lines.push(line),
      colorEnabled: false,
      mirrorRunLog: opts.mirror ?? false,
    }),
  };
}

async function runWith(
  jhBody: string,
  extraEnv: Record<string, string>,
  ctx: DefCallContext,
): Promise<{ text: string; isError: boolean; runDir?: string }> {
  const root = mkdtempSync(join(tmpdir(), "jaiph-oplog-ws-"));
  const tempRoot = mkdtempSync(join(tmpdir(), "jaiph-oplog-gen-"));
  try {
    const jh = join(root, "tool.jh");
    writeFileSync(jh, jhBody);
    const gen = loadGeneration(jh, root, tempRoot, 1, extraEnv, () => {}, "test");
    assert.ok(gen.state, `generation failed: ${gen.failures?.join("\n")}`);
    return await callDef(gen.state.callEnv, "main", [], randomUUID(), ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("a host call emits a start banner (run_id) and an end line with status/elapsed/rundir", async () => {
  const lines: string[] = [];
  const result = await runWith(
    ["export def main() {", '  log "operator visible hi"', "}", ""].join("\n"),
    {},
    { operator: operatorFor(lines) },
  );
  assert.equal(result.isError, false, `def call should succeed: ${result.text}`);

  const start = lines.find((l) => /Running .*run_id=/.test(l));
  assert.ok(start, `a start banner must be emitted; got:\n${lines.join("\n")}`);
  assert.match(start!, /^jaiph mcp: Running main run_id=/, "start names def + run_id");

  const end = lines.find((l) => /Finished /.test(l));
  assert.ok(end, "a terminal end line must be emitted");
  assert.match(end!, /status=ok exit=0 elapsed_ms=\d+/, "end line carries status + exit + elapsed_ms");
  // Host mode knows the run dir by end of call (read from the meta file).
  assert.match(end!, /rundir=\S+/, "end line includes rundir when known (host mode)");

  // Channel isolation: the operator banner must not leak into the call result
  // (what the MCP tool result / HTTP body would carry).
  assert.ok(!result.text.includes("Running main"), "operator banner is not in the call result text");
});

test("run log is NOT mirrored to the operator sink by default", async () => {
  const lines: string[] = [];
  await runWith(
    ["export def main() {", '  log "operator visible hi"', "}", ""].join("\n"),
    {},
    { operator: operatorFor(lines) },
  );
  assert.ok(
    !lines.some((l) => l.includes("operator visible hi")),
    `default (mirror off) must not echo run log to stderr; got:\n${lines.join("\n")}`,
  );
});

test("JAIPH_SERVER_LOG_RUNS opt-in mirrors the run log to the operator sink with run_id", async () => {
  const lines: string[] = [];
  await runWith(
    ["export def main() {", '  log "operator visible hi"', "}", ""].join("\n"),
    {},
    { operator: operatorFor(lines, { mirror: true }) },
  );
  const mirrored = lines.find((l) => l.includes("operator visible hi"));
  assert.ok(mirrored, `mirror opt-in must echo the run log; got:\n${lines.join("\n")}`);
  assert.match(mirrored!, /run_id=\S+$/, "mirrored line carries the run_id tail");
});

test("mirrored operator lines are credential-redacted (never print a fixture secret)", async () => {
  const SECRET = "supersecretvalue1234567";
  const lines: string[] = [];
  // The secret reaches the log line through a legitimate binding: a script
  // that `use`s the granted key reads it into a `const`, then `log`
  // interpolates that binding — the same shape a real credential leak takes.
  await runWith(
    [
      'script read_secret use LEAK_API_KEY = `printf %s "$LEAK_API_KEY"`',
      "export def main() {",
      "  const secret = run read_secret()",
      '  log "leaked ${secret}"',
      "}",
      "",
    ].join("\n"),
    { LEAK_API_KEY: SECRET },
    { operator: operatorFor(lines, { mirror: true }) },
  );
  const mirrored = lines.find((l) => l.includes("leaked"));
  assert.ok(mirrored, `the interpolated log line must be mirrored; got:\n${lines.join("\n")}`);
  assert.ok(!lines.join("\n").includes(SECRET), "no operator line may contain the raw credential value");
  assert.match(mirrored!, /leaked \[REDACTED\]/, "the secret is replaced by the redaction marker");
});
