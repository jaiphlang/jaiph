import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLogEvent, parseStepEvent } from "./events";

function bashSingleQuoted(path: string): string {
  return `'${path.replace(/'/g, `'\"'\"'`)}'`;
}

// === parseLogEvent ===

test("parseLogEvent: returns undefined for line without event prefix", () => {
  assert.equal(parseLogEvent("just a regular log line"), undefined);
});

test("parseLogEvent: returns undefined for invalid JSON after prefix", () => {
  assert.equal(parseLogEvent("__JAIPH_EVENT__ not-json"), undefined);
});

test("parseLogEvent: returns undefined for non-LOG/LOGERR type", () => {
  const line = '__JAIPH_EVENT__ {"type":"STEP_START","message":"hi","depth":0}';
  assert.equal(parseLogEvent(line), undefined);
});

test("parseLogEvent: parses valid LOG event", () => {
  const line = '__JAIPH_EVENT__ {"type":"LOG","message":"hello world","depth":2}';
  const result = parseLogEvent(line);
  assert.deepEqual(result, { type: "LOG", message: "hello world", depth: 2 });
});

test("parseLogEvent: parses valid LOGERR event", () => {
  const line = '__JAIPH_EVENT__ {"type":"LOGERR","message":"error occurred","depth":1}';
  const result = parseLogEvent(line);
  assert.deepEqual(result, { type: "LOGERR", message: "error occurred", depth: 1 });
});

test("parseLogEvent: defaults message to empty string when not a string", () => {
  const line = '__JAIPH_EVENT__ {"type":"LOG","message":123,"depth":0}';
  const result = parseLogEvent(line);
  assert.ok(result);
  assert.equal(result!.message, "");
});

test("parseLogEvent: defaults depth to 0 when not a number", () => {
  const line = '__JAIPH_EVENT__ {"type":"LOG","message":"hi","depth":"bad"}';
  const result = parseLogEvent(line);
  assert.ok(result);
  assert.equal(result!.depth, 0);
});

test("parseLogEvent: handles prefix appearing after other text in line", () => {
  const line = 'some prefix text __JAIPH_EVENT__ {"type":"LOG","message":"found","depth":0}';
  const result = parseLogEvent(line);
  assert.ok(result);
  assert.equal(result!.message, "found");
});

test("parseLogEvent: trims leading blank lines from message", () => {
  const line = '__JAIPH_EVENT__ {"type":"LOG","message":"\\n\\nhello","depth":0}';
  const result = parseLogEvent(line);
  assert.ok(result);
  assert.equal(result!.message, "hello");
});

// === parseStepEvent ===

test("parseStepEvent: returns undefined for line without event prefix", () => {
  assert.equal(parseStepEvent("regular output"), undefined);
});

test("parseStepEvent: returns undefined for invalid JSON after prefix", () => {
  assert.equal(parseStepEvent("__JAIPH_EVENT__ {broken"), undefined);
});

test("parseStepEvent: returns undefined for LOG type", () => {
  const line = '__JAIPH_EVENT__ {"type":"LOG","message":"hi","depth":0}';
  assert.equal(parseStepEvent(line), undefined);
});

test("parseStepEvent: returns undefined when required string fields are missing", () => {
  const line = '__JAIPH_EVENT__ {"type":"STEP_START","kind":"rule"}';
  assert.equal(parseStepEvent(line), undefined);
});

test("parseStepEvent: parses minimal valid STEP_START event", () => {
  const event = {
    type: "STEP_START",
    func: "entry::ok",
    kind: "rule",
    name: "entry::ok",
    ts: "2024-01-01T00:00:00Z",
    id: "abc123",
    run_id: "run1",
  };
  const line = `__JAIPH_EVENT__ ${JSON.stringify(event)}`;
  const result = parseStepEvent(line);
  assert.ok(result);
  assert.equal(result!.type, "STEP_START");
  assert.equal(result!.func, "entry::ok");
  assert.equal(result!.kind, "rule");
  assert.equal(result!.name, "entry::ok");
  assert.equal(result!.id, "abc123");
  assert.equal(result!.run_id, "run1");
  assert.equal(result!.status, null);
  assert.equal(result!.elapsed_ms, null);
  assert.equal(result!.parent_id, null);
  assert.equal(result!.seq, null);
  assert.equal(result!.depth, null);
  assert.equal(result!.dispatched, false);
  assert.equal(result!.channel, "");
  assert.equal(result!.out_content, "");
  assert.equal(result!.err_content, "");
});

test("parseStepEvent: parses STEP_END with status and elapsed_ms", () => {
  const event = {
    type: "STEP_END",
    func: "entry::default",
    kind: "workflow",
    name: "entry::default",
    ts: "2024-01-01T00:00:01Z",
    status: 0,
    elapsed_ms: 1500,
    out_file: "/tmp/out.txt",
    err_file: "/tmp/err.txt",
    id: "def456",
    parent_id: "abc123",
    seq: 1,
    depth: 2,
    run_id: "run1",
    dispatched: true,
    channel: "findings",
    out_content: "output text",
    err_content: "error text",
  };
  const line = `__JAIPH_EVENT__ ${JSON.stringify(event)}`;
  const result = parseStepEvent(line);
  assert.ok(result);
  assert.equal(result!.type, "STEP_END");
  assert.equal(result!.status, 0);
  assert.equal(result!.elapsed_ms, 1500);
  assert.equal(result!.out_file, "/tmp/out.txt");
  assert.equal(result!.err_file, "/tmp/err.txt");
  assert.equal(result!.parent_id, "abc123");
  assert.equal(result!.seq, 1);
  assert.equal(result!.depth, 2);
  assert.equal(result!.dispatched, true);
  assert.equal(result!.channel, "findings");
  assert.equal(result!.out_content, "output text");
  assert.equal(result!.err_content, "error text");
});

test("parseStepEvent: parses params as array of [key, value] pairs", () => {
  const event = {
    type: "STEP_START",
    func: "entry::ok",
    kind: "rule",
    name: "entry::ok",
    params: [["key1", "val1"], ["key2", "val2"]],
  };
  const line = `__JAIPH_EVENT__ ${JSON.stringify(event)}`;
  const result = parseStepEvent(line);
  assert.ok(result);
  assert.deepEqual(result!.params, [["key1", "val1"], ["key2", "val2"]]);
});

test("parseStepEvent: filters invalid params entries", () => {
  const event = {
    type: "STEP_START",
    func: "entry::ok",
    kind: "rule",
    name: "entry::ok",
    params: [["valid", "pair"], "not-an-array", [123, "bad-key"], ["only-one"]],
  };
  const line = `__JAIPH_EVENT__ ${JSON.stringify(event)}`;
  const result = parseStepEvent(line);
  assert.ok(result);
  assert.deepEqual(result!.params, [["valid", "pair"]]);
});

test("parseStepEvent: defaults params to empty array when not provided", () => {
  const event = {
    type: "STEP_START",
    func: "entry::ok",
    kind: "rule",
    name: "entry::ok",
  };
  const line = `__JAIPH_EVENT__ ${JSON.stringify(event)}`;
  const result = parseStepEvent(line);
  assert.ok(result);
  assert.deepEqual(result!.params, []);
});

// Regression: JS kernel JSON.stringify must produce valid JSON for STEP_END out_content
// (tabs, ANSI ESC, etc.); otherwise parseStepEvent fails and CI shows raw __JAIPH_EVENT__ lines.
test("parseStepEvent: STEP_END with tabs and ANSI in out_content via JS kernel emit", () => {
  const raw = "a\tb\x1b[0mc";
  const event = {
    type: "STEP_END",
    func: "f",
    kind: "rule",
    name: "n",
    ts: "t",
    status: 1,
    elapsed_ms: null,
    out_file: "",
    err_file: "",
    id: "i",
    parent_id: null,
    seq: null,
    depth: null,
    run_id: "r",
    out_content: raw,
  };
  const json = JSON.stringify(event);
  assert.doesNotThrow(() => JSON.parse(json), "JSON.stringify must yield valid JSON string field");
  const line = `__JAIPH_EVENT__ ${json}`;
  const parsed = parseStepEvent(line);
  assert.ok(parsed, "expected parseStepEvent to accept JS-serialized STEP_END JSON");
  assert.equal(parsed!.out_content, "a\tb\x1b[0mc");
});

// log / logerr use echo -e for TTY output; JSON payloads still carry the raw message (no echo -e on json_escape input).
test("jaiph::log and jaiph::logerr: echo -e for stdout/stderr; LOG JSON message stays literal backslash escapes", () => {
  const stdlibSh = join(process.cwd(), "src/jaiph_stdlib.sh");
  const dir = mkdtempSync(join(tmpdir(), "jaiph-log-escape-"));
  const stdoutPath = join(dir, "stdout.txt");
  const stderrPath = join(dir, "stderr.txt");
  const eventsPath = join(dir, "events.txt");
  try {
    const bundledStdlib = join(process.cwd(), "dist/src/jaiph_stdlib.sh");
    const script = [
      `export JAIPH_STDLIB=${bashSingleQuoted(bundledStdlib)}`,
      `exec 3>${bashSingleQuoted(eventsPath)}`,
      `source ${bashSingleQuoted(stdlibSh)}`,
      `jaiph::log "line1\\nline2" >${bashSingleQuoted(stdoutPath)}`,
      `jaiph::logerr "err1\\terr2" 2>${bashSingleQuoted(stderrPath)}`,
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = readFileSync(stdoutPath, "utf8");
    assert.equal(out, "line1\nline2\n");
    const err = readFileSync(stderrPath, "utf8");
    assert.equal(err, "err1\terr2\n");
    const evLines = readFileSync(eventsPath, "utf8").trimEnd().split("\n");
    assert.equal(evLines.length, 2);
    const logParsed = parseLogEvent(evLines[0]!);
    const logerrParsed = parseLogEvent(evLines[1]!);
    assert.ok(logParsed);
    assert.ok(logerrParsed);
    assert.equal(logParsed!.message, "line1\\nline2");
    assert.equal(logerrParsed!.message, "err1\\terr2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: rules run under jaiph::execute_readonly use bash -c without re-sourcing stdlib;
// emit path must be in the environment, not only in an unexported shell variable.
test("JAIPH_EMIT_JS is exported for child bash (readonly rule subshell)", () => {
  const stdlibSh = join(process.cwd(), "src/jaiph_stdlib.sh");
  const bundledStdlib = join(process.cwd(), "dist/src/jaiph_stdlib.sh");
  const script = [
    `export JAIPH_STDLIB=${bashSingleQuoted(bundledStdlib)}`,
    `source ${bashSingleQuoted(stdlibSh)}`,
    `bash -c 'test -f "$JAIPH_EMIT_JS" && node "$JAIPH_EMIT_JS" 2>&1 | head -1'`,
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unknown mode/);
});
